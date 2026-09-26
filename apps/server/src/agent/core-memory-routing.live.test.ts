/**
 * Live eval: does the agent write what it learns about the user to core
 * memory when it should, and only then? The routing rule it measures is
 * design/memory.md → Core Memory vs Hindsight.
 *
 * Each labelled case in `test/fixtures/evals/core-memory-routing.json` is one
 * single-turn conversation through the live-eval harness (`src/test/live-eval.ts`):
 * the production prompt, the built-in tool definitions and the agent loop on
 * the seeded profile's model, with core memory held in process and every other
 * tool handler stubbed. Each case runs in two core-memory states: empty, where
 * the prompt shows the onboarding text, and established, holding the fixture's
 * blocks. No steering rules. It also checks what a core write says: whether it targets one of
 * the case's expected blocks, whether it uses relative time words ("recently",
 * "last month") and, in the established state, which established lines the
 * rewritten block lost and whether it still holds what the case ends.
 *
 * It reports rather than asserts. One sample per case on a non-deterministic
 * model makes any threshold either too loose to catch a regression or flaky,
 * so the per-case calls and the summary rates are printed for a human to
 * compare against the numbers recorded in design/memory.md. The test fails
 * only when a turn does not complete.
 *
 * Skipped unless `LIVE=1` and `ANTHROPIC_API_KEY` are set. A full run is 57
 * turns on Sonnet 5, about $0.60 per sample of every case.
 *
 *   set -a; . ./.env; set +a; LIVE=1 pnpm test:live src/agent/core-memory-routing.live.test.ts
 *
 * `EVAL_CASES` (comma-separated case ids) narrows the run, `EVAL_REPEATS`
 * samples every case that many times, and `LIVE_MODEL` overrides the model.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as R from "remeda";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicProvider } from "../llm/anthropic.js";
import { expectDefined } from "../test/assertions.js";
import { relativeTimeWords } from "../test/eval-checks.js";
import {
  coreMemoryWrites,
  createUsageMeter,
  EVAL_MODEL,
  EVAL_REPEATS,
  EvalCoreMemory,
  type EvalFailure,
  type EvalMetric,
  isFailure,
  LIVE_API_KEY,
  memoryCallsByIteration,
  oneLine,
  rateTable,
  runEvalTurn,
  withRepeats,
} from "../test/live-eval.js";
import type { CoreMemoryBlock } from "./service.js";

const RoutingSchema = z.enum(["core", "hindsight", "none"]);
type Routing = z.infer<typeof RoutingSchema>;

const StateSchema = z.enum(["empty", "established"]);

/** An established block, one entry per line. Anchors are the single words that carry the line's fact. */
const EstablishedBlockSchema = z.object({
  key: z.string(),
  lines: z
    .array(
      z.object({
        text: z.string(),
        anchors: z.array(z.string().regex(/^[A-Za-z0-9]+$/)).nonempty(),
      }),
    )
    .nonempty(),
});
type EstablishedBlock = z.infer<typeof EstablishedBlockSchema>;

const EvalFileSchema = z.object({
  established: z.array(EstablishedBlockSchema),
  cases: z.array(
    z.object({
      id: z.string(),
      expect: RoutingSchema,
      inPassing: z.boolean().optional(),
      state: StateSchema.optional(),
      message: z.string(),
      note: z.string(),
      keys: z.array(z.string()).optional(),
      changes: z.array(z.string()).optional(),
      drops: z.array(z.string()).optional(),
    }),
  ),
});

const EVAL = EvalFileSchema.parse(
  JSON.parse(
    readFileSync(join(process.cwd(), "test/fixtures/evals/core-memory-routing.json"), "utf8"),
  ),
);

const ONLY = process.env.EVAL_CASES?.split(",").map((id) => id.trim());

const STATES: ReadonlyArray<{
  state: z.infer<typeof StateSchema>;
  established: ReadonlyArray<EstablishedBlock>;
}> = [
  { state: "empty", established: [] },
  // In key order, as `getCoreMemoryBlocks` returns them.
  { state: "established", established: R.sortBy(EVAL.established, (b) => b.key) },
];

const RUNS = STATES.flatMap(({ state, established }) =>
  EVAL.cases
    .filter((c) => ONLY === undefined || ONLY.includes(c.id))
    .filter((c) => c.state === undefined || c.state === state)
    .map((c) => ({
      ...c,
      name: `${state}/${c.id}`,
      state,
      established,
      blocks: established.map(
        (b): CoreMemoryBlock => ({ key: b.key, content: b.lines.map((l) => l.text).join("\n") }),
      ),
    })),
);

type Run = (typeof RUNS)[number];

interface Outcome {
  repeat: number;
  state: string;
  id: string;
  expect: Routing;
  /** The fact comes up while the user asks for something else. */
  inPassing: boolean;
  /** Memory tools called in the first response. */
  first: string[];
  /** Memory tools called anywhere in the turn, in call order. */
  turn: string[];
  coreWrites: ReadonlyArray<CoreMemoryBlock>;
  /** Every core write targeted one of the case's `keys`. */
  keyOk: boolean | null;
  /** Established state: established lines the rewritten blocks lost, beyond the case's `changes`. */
  lost: string[] | null;
  /** Established state: the case's `drops` a rewritten block still holds. */
  stale: string[] | null;
  /** Relative time words in the blocks the turn wrote. */
  relativeTime: string[];
  reply: string;
}

type Sample = Outcome | (EvalFailure & { state: string });

/** Every sample of each run, by run name. */
const samples = new Map<string, Sample[]>();

function record(name: string, sample: Sample): void {
  samples.set(name, [...(samples.get(name) ?? []), sample]);
}
const usage = createUsageMeter();

/**
 * A rewritten block keeps an established line while it still names every one
 * of the line's anchors: rephrasing around them passes ("London, United
 * Kingdom"), a dropped fact doesn't.
 */
function keeps(content: string, anchors: ReadonlyArray<string>): boolean {
  const tokens = new Set(content.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  return anchors.every((a) => tokens.has(a.toLowerCase()));
}

function mentions(text: string, fragments: ReadonlyArray<string>): boolean {
  return fragments.some((f) => text.toLowerCase().includes(f.toLowerCase()));
}

/**
 * What the turn's core writes say: the target block in either state, and
 * against the established blocks, the lines a rewrite lost and what it still
 * holds that the case ends.
 */
function checkWrites(
  run: Run,
  writes: ReadonlyArray<CoreMemoryBlock>,
): Pick<Outcome, "keyOk" | "lost" | "stale"> {
  if (writes.length === 0) return { keyOk: null, lost: null, stale: null };
  // The last write to a key is the block the next turn sees.
  const finals = [...new Map(writes.map((w) => [w.key, w])).values()];
  const { keys, drops } = run;
  const keyOk = keys === undefined ? null : finals.every((w) => keys.includes(w.key));
  if (run.state !== "established") return { keyOk, lost: null, stale: null };

  const exempt = [...(run.changes ?? []), ...(drops ?? [])];
  const rewrites = finals.flatMap((w) => {
    const block = run.established.find((b) => b.key === w.key);
    return block ? [{ content: w.content, lines: block.lines }] : [];
  });
  return {
    keyOk,
    lost:
      rewrites.length === 0
        ? null
        : rewrites.flatMap(({ content, lines }) =>
            lines
              .filter((l) => !mentions(l.text, exempt) && !keeps(content, l.anchors))
              .map((l) => l.text),
          ),
    stale:
      drops === undefined
        ? null
        : drops.filter((d) => finals.some((w) => mentions(w.content, [d]))),
  };
}

function updates(o: Outcome): boolean {
  return o.turn.includes("core_memory_update");
}

function retains(o: Outcome): boolean {
  return o.turn.includes("memory_retain");
}

function labelled(routing: Routing): (o: Outcome) => boolean {
  return (o) => o.expect === routing;
}

const METRICS: ReadonlyArray<EvalMetric<Outcome>> = [
  { name: "core recall (turn)", of: labelled("core"), hit: updates },
  { name: "  announced", of: (o) => o.expect === "core" && !o.inPassing, hit: updates },
  { name: "  in passing", of: (o) => o.expect === "core" && o.inPassing, hit: updates },
  { name: "  to an expected block", of: (o) => o.keyOk !== null, hit: (o) => o.keyOk === true },
  {
    name: "  dropping what ended",
    of: (o) => o.stale !== null,
    hit: (o) => o.stale?.length === 0,
  },
  {
    name: "core recall (first response)",
    of: labelled("core"),
    hit: (o) => o.first.includes("core_memory_update"),
  },
  {
    name: "core cases retained instead",
    of: labelled("core"),
    hit: (o) => retains(o) && !updates(o),
  },
  { name: "core writes, hindsight cases", of: labelled("hindsight"), hit: updates },
  { name: "core writes, none cases", of: labelled("none"), hit: updates },
  {
    name: "rewrites that lost a line",
    of: (o) => o.lost !== null,
    hit: (o) => (o.lost?.length ?? 0) > 0,
  },
  {
    name: "writes with relative time words",
    of: (o) => o.coreWrites.length > 0,
    hit: (o) => o.relativeTime.length > 0,
  },
  { name: "retains, hindsight cases", of: labelled("hindsight"), hit: retains },
  {
    name: "any memory write, none cases",
    of: labelled("none"),
    hit: (o) => updates(o) || retains(o),
  },
];

function verdict(o: Outcome): string {
  if (o.expect !== "core") return updates(o) ? "FP   " : "ok   ";
  if (!updates(o)) return "MISS ";
  return (o.stale?.length ?? 0) > 0 ? "STALE" : "ok   ";
}

function report(): void {
  const byRun = RUNS.map((run) => ({
    run,
    samples: R.sortBy(samples.get(run.name) ?? [], (o) => o.repeat),
  }));
  const rows = byRun.flatMap((r) => r.samples);
  if (rows.length === 0) return;

  console.log(`\nCore-memory routing on ${EVAL_MODEL}, ${EVAL_REPEATS} sample(s) per case\n`);
  for (const { run, samples: runSamples } of byRun) {
    const passes = runSamples.filter((o) => !isFailure(o) && verdict(o).trim() === "ok").length;
    console.log(
      `${`${passes}/${EVAL_REPEATS}`.padEnd(5)} ${run.state.padEnd(11)} ${run.id.padEnd(18)} ${run.expect}`,
    );
    for (const o of runSamples) {
      if (isFailure(o)) {
        console.log(`  FAILED #${o.repeat} ${o.failure}`);
        continue;
      }
      const keys = o.coreWrites.map((w) => w.key).join(",");
      console.log(
        `  ${verdict(o)} #${o.repeat} first=[${o.first.join(",")}] turn=[${o.turn.join(",")}]` +
          `${keys ? ` keys=${keys}` : ""}${o.keyOk === false ? " (unexpected block)" : ""}`,
      );
      for (const w of o.coreWrites) console.log(`          ${w.key} := ${oneLine(w.content, 400)}`);
      if (o.lost?.length) console.log(`          lost: ${o.lost.join(" | ")}`);
      if (o.stale?.length) console.log(`          still holds: ${o.stale.join(", ")}`);
      if (o.relativeTime.length > 0)
        console.log(`          relative time: ${o.relativeTime.join(", ")}`);
      console.log(`          reply: ${oneLine(o.reply, 120)}`);
    }
  }

  console.table(rateTable(METRICS, { ...R.groupBy(rows, (o) => o.state), all: rows }));
  console.log(`Usage: ${usage.summary()}`);
}

describe.skipIf(LIVE_API_KEY === undefined)(
  `core-memory routing on ${EVAL_MODEL} (live eval)`,
  () => {
    const nonce = randomUUID();

    afterAll(report);

    it.concurrent.each(withRepeats(RUNS))("$name #$repeat", async (run) => {
      try {
        const { result } = await runEvalTurn({
          provider: new AnthropicProvider(expectDefined(LIVE_API_KEY, "API key")),
          coreMemory: new EvalCoreMemory(run.blocks),
          rules: [],
          history: [],
          message: run.message,
          cacheKey: `${nonce}-${run.state}`,
        });
        usage.add(result.usage);
        expect(result.degraded).toBeUndefined();
        expect(result.text).not.toBe("");

        const byIteration = memoryCallsByIteration(result.newMessages);
        const calls = byIteration.flat();
        const coreWrites = coreMemoryWrites(result.newMessages);
        record(run.name, {
          repeat: run.repeat,
          state: run.state,
          id: run.id,
          expect: run.expect,
          inPassing: run.inPassing ?? false,
          first: (byIteration[0] ?? []).map((c) => c.name),
          turn: calls.map((c) => c.name),
          coreWrites,
          ...checkWrites(run, coreWrites),
          relativeTime: coreWrites.flatMap((w) => relativeTimeWords(w.content)),
          reply: result.text,
        });
      } catch (err) {
        record(run.name, {
          repeat: run.repeat,
          state: run.state,
          failure: oneLine(String(err), 300),
        });
        throw err;
      }
    });
  },
);
