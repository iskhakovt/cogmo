/**
 * Live eval: over a multi-turn conversation, does the agent write a core fact
 * to core memory in the turn it comes up, and does a change replace the value
 * it supersedes? The rule it measures is design/memory.md → Core Memory vs
 * Hindsight; `core-memory-routing.live.test.ts` covers the single-turn case.
 *
 * Each scenario in `test/fixtures/evals/core-memory-multiturn.json` is a
 * scripted conversation through the live-eval harness (`src/test/live-eval.ts`),
 * starting from the fixture's established blocks. Core memory is held in
 * process and carried across turns, so each turn's prompt shows what earlier
 * turns wrote, and the history carries every tool call and result. One turn
 * states a core fact, the others hold nothing core memory should keep.
 *
 * Checks are regexes over the blocks after each turn: whether the fact is
 * there (`expect`), whether a line still states the superseded value without
 * marking it as past (`stale`), and whether the established facts survived the
 * whole-block rewrites. Those are one anchor per established line (`anchors`),
 * less any the scenario's `stale` supersedes, plus the scenario's own `keep`.
 * Like the single-turn eval it reports rather than asserts, and fails only
 * when a turn does not complete.
 *
 * Skipped unless `LIVE=1` and `ANTHROPIC_API_KEY` are set. A full run is 32
 * turns on Sonnet 5, about $0.40.
 *
 *   set -a; . ./.env; set +a; LIVE=1 pnpm test:live src/agent/core-memory-multiturn.live.test.ts
 *
 * `EVAL_CASES` (comma-separated scenario ids) narrows the run, `EVAL_REPEATS`
 * samples every scenario that many times, and `LIVE_MODEL` overrides the model.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as R from "remeda";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicProvider } from "../llm/anthropic.js";
import { expectDefined } from "../test/assertions.js";
import { type StaleStatus, staleStatus } from "../test/eval-checks.js";
import {
  CoreMemoryBlocksSchema,
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
  runEvalConversation,
  shownText,
  withRepeats,
} from "../test/live-eval.js";
import type { CoreMemoryBlock } from "./service.js";

const EvalFileSchema = z.object({
  established: CoreMemoryBlocksSchema,
  anchors: z.array(z.string()).nonempty(),
  scenarios: z.array(
    z
      .object({
        id: z.string(),
        category: z.enum(["buried", "update"]),
        turns: z.array(z.string()).min(2),
        factTurn: z.number().int().nonnegative(),
        expect: z.string(),
        stale: z.string().optional(),
        keep: z.array(z.string()).optional(),
        note: z.string(),
      })
      .refine((s) => s.factTurn < s.turns.length, "factTurn is past the last turn"),
  ),
});

type Scenario = z.infer<typeof EvalFileSchema>["scenarios"][number];

const EVAL = EvalFileSchema.parse(
  JSON.parse(
    readFileSync(join(process.cwd(), "test/fixtures/evals/core-memory-multiturn.json"), "utf8"),
  ),
);

const ONLY = process.env.EVAL_CASES?.split(",").map((id) => id.trim());

const SCENARIOS = EVAL.scenarios.filter((s) => ONLY === undefined || ONLY.includes(s.id));

function mentions(blocks: ReadonlyArray<CoreMemoryBlock>, pattern: string): boolean {
  const re = new RegExp(pattern, "i");
  return blocks.some((b) => re.test(b.content));
}

interface TurnRecord {
  writes: ReadonlyArray<CoreMemoryBlock>;
  retains: number;
  blocksAfter: ReadonlyArray<CoreMemoryBlock>;
  reply: string;
}

interface Outcome {
  repeat: number;
  scenario: Scenario;
  turns: ReadonlyArray<TurnRecord>;
  /** First turn after which the blocks match `expect`. */
  learnedAt: number | undefined;
  /** How the final blocks state the superseded value, for `update` scenarios. */
  stale: StaleStatus | undefined;
  /** Established facts the final blocks no longer match. */
  lost: ReadonlyArray<string>;
  /** Core writes in turns other than the fact turn. */
  otherTurnWrites: number;
}

type Sample = Outcome | (EvalFailure & { scenario: Scenario });

/** Every sample of each scenario, by scenario id. */
const samples = new Map<string, Sample[]>();
const usage = createUsageMeter();

function record(sample: Sample): void {
  samples.set(sample.scenario.id, [...(samples.get(sample.scenario.id) ?? []), sample]);
}

/** Patterns for the established facts a scenario leaves in place. */
function kept(scenario: Scenario): string[] {
  const { stale } = scenario;
  const superseded = (anchor: string) => stale !== undefined && new RegExp(stale, "i").test(anchor);
  return [...EVAL.anchors.filter((a) => !superseded(a)), ...(scenario.keep ?? [])];
}

function outcomeOf(scenario: Scenario, repeat: number, turns: ReadonlyArray<TurnRecord>): Outcome {
  const finalBlocks = turns.at(-1)?.blocksAfter ?? [];
  const learned = turns.findIndex((t) => mentions(t.blocksAfter, scenario.expect));
  return {
    repeat,
    scenario,
    turns,
    learnedAt: learned === -1 ? undefined : learned,
    stale: scenario.stale === undefined ? undefined : staleStatus(finalBlocks, scenario.stale),
    lost: kept(scenario).filter((pattern) => !mentions(finalBlocks, pattern)),
    otherTurnWrites: R.sumBy(
      turns.filter((_t, i) => i !== scenario.factTurn),
      (t) => t.writes.length,
    ),
  };
}

/** The fact reached core memory and the scenario supersedes a value. */
function updated(o: Outcome): boolean {
  return o.stale !== undefined && o.learnedAt !== undefined;
}

function verdict(o: Outcome): string {
  if (o.learnedAt === undefined) return "MISS";
  if (o.stale === "current") return "BOTH";
  return o.learnedAt === o.scenario.factTurn ? "ok  " : "LATE";
}

const METRICS: ReadonlyArray<EvalMetric<Outcome>> = [
  {
    name: "fact written in its turn",
    of: () => true,
    hit: (o) => o.learnedAt === o.scenario.factTurn,
  },
  { name: "fact written by the end", of: () => true, hit: (o) => o.learnedAt !== undefined },
  { name: "old value replaced", of: updated, hit: (o) => o.stale === "absent" },
  { name: "old value kept as past", of: updated, hit: (o) => o.stale === "past" },
  { name: "old value still current", of: updated, hit: (o) => o.stale === "current" },
  { name: "established facts kept", of: () => true, hit: (o) => o.lost.length === 0 },
  {
    name: "no core writes outside the fact turn",
    of: () => true,
    hit: (o) => o.otherTurnWrites === 0,
  },
];

function report(): void {
  const byScenario = SCENARIOS.map((scenario) => ({
    scenario,
    samples: R.sortBy(samples.get(scenario.id) ?? [], (o) => o.repeat),
  }));
  const rows = byScenario.flatMap((s) => s.samples);
  if (rows.length === 0) return;

  console.log(
    `\nCore memory over multi-turn conversations on ${EVAL_MODEL}, ${EVAL_REPEATS} sample(s) per scenario\n`,
  );
  for (const { scenario, samples: scenarioSamples } of byScenario) {
    const { id, category, factTurn } = scenario;
    const passes = scenarioSamples.filter(
      (o) => !isFailure(o) && verdict(o).trim() === "ok",
    ).length;
    console.log(
      `${`${passes}/${EVAL_REPEATS}`.padEnd(5)} ${category.padEnd(6)} ${id} fact@${factTurn}`,
    );
    for (const o of scenarioSamples) {
      if (isFailure(o)) {
        console.log(`  FAILED #${o.repeat} ${o.failure}`);
        continue;
      }
      const perTurn = o.turns
        .map((t) => {
          const keys = t.writes.map((w) => w.key).join("+");
          return `${keys || "-"}${t.retains > 0 ? `/retain×${t.retains}` : ""}`;
        })
        .join(" | ");
      console.log(
        `  ${verdict(o)} #${o.repeat} learned@${o.learnedAt ?? "-"}${o.stale ? ` old=${o.stale}` : ""} ` +
          `lost=[${o.lost.join(",")}] other-turn writes=${o.otherTurnWrites}  turns: ${perTurn}`,
      );
      o.turns.forEach((t, i) => {
        for (const w of t.writes)
          console.log(`         t${i} ${w.key} := ${oneLine(w.content, 300)}`);
      });
      console.log(`         reply@${factTurn}: ${oneLine(o.turns[factTurn]?.reply ?? "", 120)}`);
    }
  }

  console.table(rateTable(METRICS, { ...R.groupBy(rows, (o) => o.scenario.category), all: rows }));
  console.log(`Usage: ${usage.summary()}`);
}

describe.skipIf(LIVE_API_KEY === undefined)(
  `core memory over multi-turn conversations on ${EVAL_MODEL} (live eval)`,
  () => {
    const nonce = randomUUID();

    afterAll(report);

    it.concurrent.each(withRepeats(SCENARIOS))(
      "$category/$id #$repeat",
      async ({ repeat, ...scenario }) => {
        try {
          const conversation = await runEvalConversation({
            provider: new AnthropicProvider(expectDefined(LIVE_API_KEY, "API key")),
            coreMemory: new EvalCoreMemory(EVAL.established),
            rules: [],
            messages: scenario.turns,
            cacheKey: `${nonce}-${scenario.id}`,
          });
          for (const t of conversation.turns) usage.add(t.result.usage);
          for (const t of conversation.turns) {
            expect(t.result.degraded).toBeUndefined();
            expect(t.result.text).not.toBe("");
          }

          const turns = conversation.turns.map((t, i) => ({
            writes: coreMemoryWrites(t.result.newMessages),
            retains: memoryCallsByIteration(t.result.newMessages)
              .flat()
              .filter((c) => c.name === "memory_retain").length,
            blocksAfter: expectDefined(conversation.blocksAfter[i], "blocks after turn"),
            reply: shownText(t.result),
          }));
          record(outcomeOf(scenario, repeat, turns));
        } catch (err) {
          record({ repeat, scenario, failure: oneLine(String(err), 300) });
          throw err;
        }
      },
      600_000,
    );
  },
);
