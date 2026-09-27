/**
 * Live eval: does the agent write what it learns about the user to core
 * memory when it should, and only then, and to the right block? The routing
 * rule it measures is design/memory.md → Core Memory vs Hindsight, and the
 * scopes design/memory.md → Core Memory Scope by Profile Class.
 *
 * Each labelled case in `test/fixtures/evals/core-memory-routing.json` is one
 * single-turn conversation through the live-eval harness (`src/test/live-eval.ts`):
 * the production prompt, the built-in tool definitions and the agent loop on
 * the seeded profile's model, with core memory held in process behind the
 * production `coreMemory` namespace, so writes resolve their scope as a turn's
 * Service does, and every other tool handler stubbed. No steering rules. The
 * core-memory states a case runs in:
 *
 * - empty: an unclassed profile with no blocks, so the prompt shows onboarding;
 * - established: an unclassed profile with the fixture's blocks, `identity` among them;
 * - legacy: the same facts before `identity`, name and home in `user_profile`;
 * - classed: a profile of an unrestricted class, rendering the shared `identity`
 *   and the class's own blocks;
 * - restricted: the same in a restricted class, where an `identity` write is the
 *   class's override.
 *
 * It also checks what a core write says: whether it targets one of the case's
 * expected blocks, whether it uses relative time words ("recently", "last
 * month"), whether an `identity` write pulls in a fact that belongs elsewhere
 * (role, family, projects, preferences), and, with blocks, which established
 * lines a rewritten block lost and whether it still holds what the case ends.
 * In the legacy state it checks whether name and home stay in `user_profile`
 * beside a new `identity`; in the restricted state, whether an identity change
 * is stored as an override holding only the lines that differ, and whether the
 * reply tells the user it is saved only in this persona.
 *
 * It reports rather than asserts. One sample per case on a non-deterministic
 * model makes any threshold either too loose to catch a regression or flaky,
 * so the per-case calls and the summary rates are printed for a human to
 * compare against the numbers recorded in design/memory.md. The test fails
 * only when a turn does not complete.
 *
 * Skipped unless `LIVE=1` and `ANTHROPIC_API_KEY` are set. A full run is 92
 * turns on Sonnet 5, about $1 per sample of every case.
 *
 *   set -a; . ./.env; set +a; LIVE=1 pnpm test:live src/agent/core-memory-routing.live.test.ts
 *
 * `EVAL_CASES` (comma-separated case ids) narrows the run, `EVAL_STATES`
 * (comma-separated) the states, `EVAL_REPEATS` samples every case that many
 * times, and `LIVE_MODEL` overrides the model.
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
import {
  type CoreMemoryScope,
  IDENTITY_BLOCK_KEY,
  type ScopedCoreMemoryBlock,
} from "./core-memory/scope.js";
import type { CoreMemoryBlock } from "./service.js";

const RoutingSchema = z.enum(["core", "hindsight", "none"]);
type Routing = z.infer<typeof RoutingSchema>;

const StateSchema = z.enum(["empty", "established", "legacy", "classed", "restricted"]);
type State = z.infer<typeof StateSchema>;

const DEFAULT_STATES: ReadonlyArray<State> = ["empty", "established", "classed"];

/**
 * A block with lines, one entry per line. Anchors are the single words that
 * carry the line's fact; `identity` marks a legacy line that belongs in the
 * `identity` block.
 */
const EstablishedBlockSchema = z.object({
  key: z.string(),
  lines: z
    .array(
      z.object({
        text: z.string(),
        anchors: z.array(z.string().regex(/^[A-Za-z0-9]+$/)).nonempty(),
        identity: z.boolean().optional(),
      }),
    )
    .nonempty(),
});
type EstablishedBlock = z.infer<typeof EstablishedBlockSchema>;

const EvalFileSchema = z.object({
  established: z.array(EstablishedBlockSchema),
  legacy: z.array(EstablishedBlockSchema),
  cases: z.array(
    z.object({
      id: z.string(),
      expect: RoutingSchema,
      inPassing: z.boolean().optional(),
      states: z.array(StateSchema).optional(),
      message: z.string(),
      note: z.string(),
      keys: z.array(z.string()).optional(),
      changes: z.array(z.string()).optional(),
      drops: z.array(z.string()).optional(),
      facts: z.array(z.string()).optional(),
    }),
  ),
});

const EVAL = EvalFileSchema.parse(
  JSON.parse(
    readFileSync(join(process.cwd(), "test/fixtures/evals/core-memory-routing.json"), "utf8"),
  ),
);

const ONLY = process.env.EVAL_CASES?.split(",").map((id) => id.trim());
const ONLY_STATES = process.env.EVAL_STATES?.split(",").map((s) => StateSchema.parse(s.trim()));

/** The class the classed and restricted states speak as. */
const EVAL_CLASS = "persona";

function content(block: EstablishedBlock): string {
  return block.lines.map((l) => l.text).join("\n");
}

/** A state's scope and stored rows: in a class, `identity` is shared and the rest belong to the class. */
function stateSetup(state: State): {
  scope: CoreMemoryScope;
  established: ReadonlyArray<EstablishedBlock>;
  rows: ReadonlyArray<ScopedCoreMemoryBlock>;
} {
  const unclassed = (established: ReadonlyArray<EstablishedBlock>) => ({
    scope: { kind: "unclassed" } as const,
    established,
    rows: established.map((b) => ({ profileClass: null, key: b.key, content: content(b) })),
  });
  const classed = (restricted: boolean) => ({
    scope: { kind: "classed", profileClass: EVAL_CLASS, restricted } as const,
    established: EVAL.established,
    rows: EVAL.established.map((b) => ({
      profileClass: b.key === IDENTITY_BLOCK_KEY ? null : EVAL_CLASS,
      key: b.key,
      content: content(b),
    })),
  });
  switch (state) {
    case "empty":
      return unclassed([]);
    case "established":
      return unclassed(EVAL.established);
    case "legacy":
      return unclassed(EVAL.legacy);
    case "classed":
      return classed(false);
    case "restricted":
      return classed(true);
  }
}

const RUNS = StateSchema.options
  .filter((state) => ONLY_STATES === undefined || ONLY_STATES.includes(state))
  .flatMap((state) =>
    EVAL.cases
      .filter((c) => ONLY === undefined || ONLY.includes(c.id))
      .filter((c) => (c.states ?? DEFAULT_STATES).includes(state))
      .map((c) => ({ ...c, name: `${state}/${c.id}`, state, ...stateSetup(state) })),
  );

type Run = (typeof RUNS)[number];

interface Outcome {
  repeat: number;
  state: State;
  id: string;
  expect: Routing;
  /** The fact comes up while the user asks for something else. */
  inPassing: boolean;
  /** Memory tools called in the first response. */
  first: string[];
  /** Memory tools called anywhere in the turn, in call order. */
  turn: string[];
  coreWrites: ReadonlyArray<CoreMemoryBlock>;
  /** Every core write targeted one of the case's `keys` (legacy: wrote `identity`, rewrote at most `user_profile` besides). */
  keyOk: boolean | null;
  /** With blocks: established lines the rewritten blocks lost, beyond the case's `changes`. */
  lost: string[] | null;
  /** With blocks: the case's `drops` a rewritten block still holds. */
  stale: string[] | null;
  /** Relative time words in the blocks the turn wrote. */
  relativeTime: string[];
  /** Facts that belong outside `identity` that an `identity` write names. */
  leak: string[];
  /** Legacy, when the turn wrote `identity`: `user_profile` lines it now holds that stayed there. */
  duplicate: string[] | null;
  /** Restricted, when the turn wrote `identity`: what the override did. */
  override: {
    stored: boolean;
    /** Shared lines the case doesn't change that the override repeats. */
    repeats: string[];
    /** The reply tells the user the change is saved only in this persona. */
    toldUser: boolean;
  } | null;
  reply: string;
}

type Sample = Outcome | (EvalFailure & { state: State });

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
function keeps(text: string, anchors: ReadonlyArray<string>): boolean {
  const tokens = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  return anchors.every((a) => tokens.has(a.toLowerCase()));
}

function mentions(text: string, fragments: ReadonlyArray<string>): boolean {
  return fragments.some((f) => text.toLowerCase().includes(f.toLowerCase()));
}

/** The last write to each key: the block the next turn sees. */
function finalWrites(writes: ReadonlyArray<CoreMemoryBlock>): CoreMemoryBlock[] {
  return [...new Map(writes.map((w) => [w.key, w])).values()];
}

/**
 * What the turn's core writes say: the target block in every state, and
 * against the blocks the state starts from, the lines a rewrite lost and what
 * it still holds that the case ends. A restricted persona's `identity` write
 * is an override that holds only what differs, so it loses nothing.
 */
function checkWrites(
  run: Run,
  writes: ReadonlyArray<CoreMemoryBlock>,
): Pick<Outcome, "keyOk" | "lost" | "stale"> {
  if (writes.length === 0) return { keyOk: null, lost: null, stale: null };
  const finals = finalWrites(writes);
  const { keys, drops } = run;
  const keyOk =
    keys === undefined
      ? null
      : run.state === "legacy" && keys.includes(IDENTITY_BLOCK_KEY)
        ? finals.some((w) => w.key === IDENTITY_BLOCK_KEY) &&
          finals.every((w) => [...keys, "user_profile"].includes(w.key))
        : finals.every((w) => keys.includes(w.key));
  if (run.established.length === 0) return { keyOk, lost: null, stale: null };

  const exempt = [...(run.changes ?? []), ...(drops ?? [])];
  const rewrites = finals.flatMap((w) => {
    if (run.state === "restricted" && w.key === IDENTITY_BLOCK_KEY) return [];
    const block = run.established.find((b) => b.key === w.key);
    // A legacy block's identity lines may move to `identity`.
    const lines = block?.lines.filter((l) => !(run.state === "legacy" && l.identity)) ?? [];
    return block ? [{ content: w.content, lines }] : [];
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

/**
 * Facts that belong outside `identity` that `text` names: the case's own, by
 * fragment, and each established non-identity line's, by its anchors.
 */
function factsFromElsewhere(run: Run, text: string): string[] {
  const own = run.keys?.includes(IDENTITY_BLOCK_KEY) ? [] : (run.facts ?? []);
  const established = run.established
    .filter((b) => b.key !== IDENTITY_BLOCK_KEY)
    .flatMap((b) => b.lines.filter((l) => !l.identity && keeps(text, l.anchors)))
    .map((l) => l.text);
  return [...own.filter((f) => mentions(text, [f])), ...established];
}

/**
 * A legacy identity line `profile` still states: by its anchors, or by its
 * label with a new value ("Location: Lisbon" for "Location: London").
 */
function stillStates(profile: string, line: { text: string; anchors: ReadonlyArray<string> }) {
  const label = line.text.split(":")[0]?.trim() ?? "";
  return keeps(profile, line.anchors) || new RegExp(`^\\W*${label}\\b`, "im").test(profile);
}

function checkIdentity(
  run: Run,
  writes: ReadonlyArray<CoreMemoryBlock>,
  stored: ReadonlyArray<ScopedCoreMemoryBlock>,
  reply: string,
): Pick<Outcome, "leak" | "duplicate" | "override"> {
  const finals = finalWrites(writes);
  const identity = finals.find((w) => w.key === IDENTITY_BLOCK_KEY);
  if (identity === undefined) return { leak: [], duplicate: null, override: null };
  const leak = factsFromElsewhere(run, identity.content);

  const legacyProfile = run.established.find((b) => b.key === "user_profile");
  const duplicate =
    run.state !== "legacy" || legacyProfile === undefined
      ? null
      : (() => {
          const profile =
            finals.find((w) => w.key === "user_profile")?.content ?? content(legacyProfile);
          return legacyProfile.lines
            .filter((l) => l.identity && stillStates(profile, l))
            .map((l) => l.text);
        })();

  const shared = run.established.find((b) => b.key === IDENTITY_BLOCK_KEY);
  const override =
    run.state !== "restricted" || shared === undefined
      ? null
      : {
          stored: stored.some((r) => r.profileClass === EVAL_CLASS && r.key === IDENTITY_BLOCK_KEY),
          repeats: shared.lines
            .filter(
              (l) => !mentions(l.text, run.changes ?? []) && keeps(identity.content, l.anchors),
            )
            .map((l) => l.text),
          toldUser:
            /\bonly (?:applies )?(?:here|in this|for this|within this)|\bapplies here\b|\bthis persona\b|\bnot shared\b|\bseparately\b/i.test(
              reply,
            ),
        };
  return { leak, duplicate, override };
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

function writesIdentity(o: Outcome): boolean {
  return o.coreWrites.some((w) => w.key === IDENTITY_BLOCK_KEY);
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
  {
    name: "identity writes with a fact from elsewhere",
    of: writesIdentity,
    hit: (o) => o.leak.length > 0,
  },
  {
    name: "identity writes leaving it in user_profile",
    of: (o) => o.duplicate !== null,
    hit: (o) => (o.duplicate?.length ?? 0) > 0,
  },
  {
    name: "identity changes stored as the override",
    of: (o) => o.override !== null,
    hit: (o) => o.override?.stored === true,
  },
  {
    name: "  repeating unchanged shared lines",
    of: (o) => o.override !== null,
    hit: (o) => (o.override?.repeats.length ?? 0) > 0,
  },
  {
    name: "  told the user it is saved only here",
    of: (o) => o.override !== null,
    hit: (o) => o.override?.toldUser === true,
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
      if (o.leak.length > 0) console.log(`          identity holds: ${o.leak.join(", ")}`);
      if (o.duplicate?.length)
        console.log(`          left in user_profile: ${o.duplicate.join(" | ")}`);
      if (o.override !== null) {
        console.log(
          `          override stored=${o.override.stored} told=${o.override.toldUser}` +
            `${o.override.repeats.length ? ` repeats: ${o.override.repeats.join(" | ")}` : ""}`,
        );
      }
      console.log(`          reply: ${oneLine(o.reply, 160)}`);
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
        const coreMemory = new EvalCoreMemory(run.scope, run.rows);
        const { result } = await runEvalTurn({
          provider: new AnthropicProvider(expectDefined(LIVE_API_KEY, "API key")),
          coreMemory,
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
          ...checkIdentity(run, coreWrites, coreMemory.rows(), result.text),
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
