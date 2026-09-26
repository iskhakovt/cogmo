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
 * whole-block rewrites (`keep`). Like the single-turn eval it reports rather
 * than asserts, and fails only when a turn does not complete.
 *
 * Skipped unless `LIVE=1` and `ANTHROPIC_API_KEY` are set. A full run is 32
 * turns on Sonnet 5.
 *
 *   set -a; . ./.env; set +a; LIVE=1 pnpm test:live src/agent/core-memory-multiturn.live.test.ts
 *
 * `EVAL_CASES` (comma-separated scenario ids) narrows the run; `LIVE_MODEL`
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
  createUsageMeter,
  EVAL_MODEL,
  EvalCoreMemory,
  LIVE_API_KEY,
  memoryCallsByIteration,
  oneLine,
  runEvalConversation,
} from "../test/live-eval.js";
import type { CoreMemoryBlock } from "./service.js";

const EvalFileSchema = z.object({
  established: CoreMemoryBlocksSchema,
  scenarios: z.array(
    z
      .object({
        id: z.string(),
        category: z.enum(["buried", "update"]),
        turns: z.array(z.string()).min(2),
        factTurn: z.number().int().nonnegative(),
        expect: z.string(),
        stale: z.string().optional(),
        keep: z.array(z.string()),
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

/** Words that mark a line as history rather than the current value. */
const PAST_MARKER =
  /\b(?:previous(?:ly)?|former(?:ly)?|used to|until|moved from|left|was|before|prior|done|completed?|finished|ex-)/i;

type StaleStatus = "absent" | "past" | "current";

/** How the blocks state the value `pattern` matches: not at all, only as history, or as current. */
function staleStatus(blocks: ReadonlyArray<CoreMemoryBlock>, pattern: string): StaleStatus {
  const re = new RegExp(pattern, "i");
  const lines = blocks.flatMap((b) => b.content.split("\n")).filter((line) => re.test(line));
  if (lines.length === 0) return "absent";
  return lines.every((line) => PAST_MARKER.test(line)) ? "past" : "current";
}

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
  scenario: Scenario;
  turns: ReadonlyArray<TurnRecord>;
  /** First turn after which the blocks match `expect`. */
  learnedAt: number | undefined;
  /** How the final blocks state the superseded value, for `update` scenarios. */
  stale: StaleStatus | undefined;
  /** `keep` patterns the final blocks no longer match. */
  lost: ReadonlyArray<string>;
  /** Core writes in turns other than the fact turn that don't carry the fact. */
  unrelatedWrites: number;
}

const outcomes = new Map<string, Outcome>();
const usage = createUsageMeter();

function outcomeOf(scenario: Scenario, turns: ReadonlyArray<TurnRecord>): Outcome {
  const finalBlocks = turns.at(-1)?.blocksAfter ?? [];
  const learned = turns.findIndex((t) => mentions(t.blocksAfter, scenario.expect));
  return {
    scenario,
    turns,
    learnedAt: learned === -1 ? undefined : learned,
    stale: scenario.stale === undefined ? undefined : staleStatus(finalBlocks, scenario.stale),
    lost: scenario.keep.filter((pattern) => !mentions(finalBlocks, pattern)),
    unrelatedWrites: R.sumBy(
      turns.filter((_t, i) => i !== scenario.factTurn),
      (t) => t.writes.filter((w) => !new RegExp(scenario.expect, "i").test(w.content)).length,
    ),
  };
}

function verdict(o: Outcome): string {
  if (o.learnedAt === undefined) return "MISS";
  if (o.stale === "current") return "BOTH";
  return o.learnedAt === o.scenario.factTurn ? "ok  " : "LATE";
}

/** Summary rates: each counts the outcomes in `of` for which `hit` holds. */
const METRICS: ReadonlyArray<{
  name: string;
  of: (o: Outcome) => boolean;
  hit: (o: Outcome) => boolean;
}> = [
  {
    name: "fact written in its turn",
    of: () => true,
    hit: (o) => o.learnedAt === o.scenario.factTurn,
  },
  { name: "fact written by the end", of: () => true, hit: (o) => o.learnedAt !== undefined },
  {
    name: "old value replaced",
    of: (o) => o.stale !== undefined,
    hit: (o) => o.stale === "absent",
  },
  {
    name: "old value kept as past",
    of: (o) => o.stale !== undefined,
    hit: (o) => o.stale === "past",
  },
  {
    name: "old value still current",
    of: (o) => o.stale !== undefined,
    hit: (o) => o.stale === "current",
  },
  { name: "established facts kept", of: () => true, hit: (o) => o.lost.length === 0 },
  { name: "no unrelated core writes", of: () => true, hit: (o) => o.unrelatedWrites === 0 },
];

function report(): void {
  const rows = SCENARIOS.flatMap((s) => {
    const o = outcomes.get(s.id);
    return o ? [o] : [];
  });
  if (rows.length === 0) return;

  console.log(`\nCore memory over multi-turn conversations on ${EVAL_MODEL}\n`);
  for (const o of rows) {
    const { id, category, factTurn } = o.scenario;
    const perTurn = o.turns
      .map((t) => {
        const keys = t.writes.map((w) => w.key).join("+");
        return `${keys || "-"}${t.retains > 0 ? `/retain×${t.retains}` : ""}`;
      })
      .join(" | ");
    console.log(
      `${verdict(o)} ${category.padEnd(6)} ${id.padEnd(13)} fact@${factTurn} ` +
        `learned@${o.learnedAt ?? "-"}${o.stale ? ` old=${o.stale}` : ""} ` +
        `lost=[${o.lost.join(",")}] unrelated=${o.unrelatedWrites}  turns: ${perTurn}`,
    );
    o.turns.forEach((t, i) => {
      for (const w of t.writes) console.log(`       t${i} ${w.key} := ${oneLine(w.content, 300)}`);
    });
    console.log(`       reply@${factTurn}: ${oneLine(o.turns[factTurn]?.reply ?? "", 120)}`);
  }

  const groups = { ...R.groupBy(rows, (o) => o.scenario.category), all: rows };
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
  console.log(`Usage: ${usage.summary()}`);
}

describe.skipIf(LIVE_API_KEY === undefined)(
  `core memory over multi-turn conversations on ${EVAL_MODEL} (live eval)`,
  () => {
    const nonce = randomUUID();

    afterAll(report);

    it.concurrent.each(SCENARIOS)(
      "$category/$id",
      async (scenario) => {
        const conversation = await runEvalConversation({
          provider: new AnthropicProvider(expectDefined(LIVE_API_KEY, "API key")),
          coreMemory: new EvalCoreMemory(EVAL.established),
          rules: [],
          messages: scenario.turns,
          cacheKey: `${nonce}-${scenario.id}`,
        });

        const turns = conversation.turns.map((t, i) => {
          usage.add(t.result.usage);
          return {
            writes: coreMemoryWrites(t.result.newMessages),
            retains: memoryCallsByIteration(t.result.newMessages)
              .flat()
              .filter((c) => c.name === "memory_retain").length,
            blocksAfter: expectDefined(conversation.blocksAfter[i], "blocks after turn"),
            reply: t.result.text,
          };
        });
        outcomes.set(scenario.id, outcomeOf(scenario, turns));

        for (const t of conversation.turns) {
          expect(t.result.degraded).toBeUndefined();
          expect(t.result.text).not.toBe("");
        }
      },
      600_000,
    );
  },
);
