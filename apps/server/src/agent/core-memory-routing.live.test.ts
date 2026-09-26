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
 * blocks. No steering rules.
 *
 * It reports rather than asserts. One sample per case on a non-deterministic
 * model makes any threshold either too loose to catch a regression or flaky,
 * so the per-case calls and the summary rates are printed for a human to
 * compare against the numbers recorded in design/memory.md. The test fails
 * only when a turn does not complete.
 *
 * Skipped unless `LIVE=1` and `ANTHROPIC_API_KEY` are set. A full run is 50
 * turns on Sonnet 5, on the order of a dollar.
 *
 *   set -a; . ./.env; set +a; LIVE=1 pnpm test:live src/agent/core-memory-routing.live.test.ts
 *
 * `EVAL_CASES` (comma-separated case ids) narrows the run; `LIVE_MODEL`
 * overrides the model.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as R from "remeda";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicProvider } from "../llm/anthropic.js";
import { expectDefined } from "../test/assertions.js";
import {
  CoreMemoryBlocksSchema,
  coreMemoryWrites,
  EVAL_MODEL,
  EvalCoreMemory,
  LIVE_API_KEY,
  memoryCallsByIteration,
  oneLine,
  runEvalTurn,
} from "../test/live-eval.js";
import type { CoreMemoryBlock } from "./service.js";

const RoutingSchema = z.enum(["core", "hindsight", "none"]);
type Routing = z.infer<typeof RoutingSchema>;

const EvalFileSchema = z.object({
  established: CoreMemoryBlocksSchema,
  cases: z.array(
    z.object({
      id: z.string(),
      expect: RoutingSchema,
      inPassing: z.boolean().optional(),
      message: z.string(),
      note: z.string(),
    }),
  ),
});

const EVAL = EvalFileSchema.parse(
  JSON.parse(
    readFileSync(join(process.cwd(), "test/fixtures/evals/core-memory-routing.json"), "utf8"),
  ),
);

const ONLY = process.env.EVAL_CASES?.split(",").map((id) => id.trim());

const STATES: ReadonlyArray<{ state: string; blocks: ReadonlyArray<CoreMemoryBlock> }> = [
  { state: "empty", blocks: [] },
  { state: "established", blocks: EVAL.established },
];

const RUNS = STATES.flatMap(({ state, blocks }) =>
  EVAL.cases
    .filter((c) => ONLY === undefined || ONLY.includes(c.id))
    .map((c) => ({ name: `${state}/${c.id}`, state, blocks, ...c })),
);

interface Outcome {
  state: string;
  id: string;
  expect: Routing;
  /** The fact comes up while the user asks for something else. */
  inPassing: boolean;
  /** Memory tools called in the first response. */
  first: string[];
  /** Memory tools called anywhere in the turn, in call order. */
  turn: string[];
  coreWrites: ReadonlyArray<{ key: string; content: string }>;
  reply: string;
}

const outcomes = new Map<string, Outcome>();

function updates(o: Outcome): boolean {
  return o.turn.includes("core_memory_update");
}

function retains(o: Outcome): boolean {
  return o.turn.includes("memory_retain");
}

function labelled(routing: Routing): (o: Outcome) => boolean {
  return (o) => o.expect === routing;
}

/** Summary rates: each counts the outcomes in `of` for which `hit` holds. */
const METRICS: ReadonlyArray<{
  name: string;
  of: (o: Outcome) => boolean;
  hit: (o: Outcome) => boolean;
}> = [
  { name: "core recall (turn)", of: labelled("core"), hit: updates },
  { name: "  announced", of: (o) => o.expect === "core" && !o.inPassing, hit: updates },
  { name: "  in passing", of: (o) => o.expect === "core" && o.inPassing, hit: updates },
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
  { name: "retains, hindsight cases", of: labelled("hindsight"), hit: retains },
  {
    name: "any memory write, none cases",
    of: labelled("none"),
    hit: (o) => updates(o) || retains(o),
  },
];

function verdict(o: Outcome): string {
  if (o.expect === "core") return updates(o) ? "ok  " : "MISS";
  return updates(o) ? "FP  " : "ok  ";
}

function report(): void {
  const rows = RUNS.flatMap((r) => {
    const o = outcomes.get(r.name);
    return o ? [o] : [];
  });
  if (rows.length === 0) return;

  console.log(`\nCore-memory routing on ${EVAL_MODEL}\n`);
  for (const o of rows) {
    const keys = o.coreWrites.map((w) => w.key).join(",");
    console.log(
      `${verdict(o)} ${o.state.padEnd(11)} ${o.id.padEnd(18)} ${o.expect.padEnd(9)} ` +
        `first=[${o.first.join(",")}] turn=[${o.turn.join(",")}]${keys ? ` keys=${keys}` : ""}`,
    );
    for (const w of o.coreWrites) console.log(`       ${w.key} := ${oneLine(w.content, 400)}`);
    console.log(`       reply: ${oneLine(o.reply, 120)}`);
  }

  const groups = { ...R.groupBy(rows, (o) => o.state), all: rows };
  console.table(
    Object.fromEntries(
      METRICS.map((m) => [
        m.name,
        R.mapValues(groups, (group) => {
          const population = group.filter(m.of);
          return `${population.filter(m.hit).length}/${population.length}`;
        }),
      ]),
    ),
  );
}

describe.skipIf(LIVE_API_KEY === undefined)(
  `core-memory routing on ${EVAL_MODEL} (live eval)`,
  () => {
    const nonce = randomUUID();

    afterAll(report);

    it.concurrent.each(RUNS)("$name", async (run) => {
      const { result } = await runEvalTurn({
        provider: new AnthropicProvider(expectDefined(LIVE_API_KEY, "API key")),
        coreMemory: new EvalCoreMemory(run.blocks),
        rules: [],
        history: [],
        message: run.message,
        cacheKey: `${nonce}-${run.state}`,
      });

      const byIteration = memoryCallsByIteration(result.newMessages);
      const calls = byIteration.flat();
      outcomes.set(run.name, {
        state: run.state,
        id: run.id,
        expect: run.expect,
        inPassing: run.inPassing ?? false,
        first: (byIteration[0] ?? []).map((c) => c.name),
        turn: calls.map((c) => c.name),
        coreWrites: coreMemoryWrites(result.newMessages),
        reply: result.text,
      });

      expect(result.degraded).toBeUndefined();
      expect(result.text).not.toBe("");
    });
  },
);
