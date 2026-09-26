/**
 * Live eval: does a behavioural correction the user makes in two
 * conversations become an active steering rule, and does the agent follow it
 * in the next conversation? It runs Stage 1 of design/evolution.md end to end
 * at the model level: the Observer's correction extraction, graduation at
 * `observationCount >= 2`, and the rule rendered under `# Rules`.
 *
 * Each scenario in `test/fixtures/evals/correction-learning.json` runs two
 * scripted conversations through the live-eval harness (`src/test/live-eval.ts`),
 * each ending in the same correction worded differently. After each one,
 * `extractCorrections` runs on its transcript on the Observer's model (the
 * profile's extraction model, else its chat model), writing through
 * `DrizzleAgentStore` to a PGlite database of the scenario's own. The second
 * extraction sees the first one's rule, so graduation depends on the model
 * matching it. Then a probe message opens a fresh conversation, once with the
 * active rules in the prompt and once without as a baseline, and a
 * deterministic check on each reply says whether it follows the correction.
 *
 * Every conversation, the probes included, starts from the fixture's
 * established blocks, so the probe measures the rule alone. The agent may also
 * save the correction to core memory as a standing preference; those writes
 * are reported, not carried forward.
 *
 * Like the other evals it reports rather than asserts, and fails only when a
 * turn or an extraction does not complete.
 *
 * Skipped unless `LIVE=1` and `ANTHROPIC_API_KEY` are set. A full run is 24
 * turns and 8 extractions on Sonnet 5.
 *
 *   set -a; . ./.env; set +a; LIVE=1 pnpm test:live src/agent/evolution/correction-learning.live.test.ts
 *
 * `EVAL_CASES` (comma-separated scenario ids) narrows the run; `LIVE_MODEL`
 * overrides the model.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicProvider } from "../../llm/anthropic.js";
import { expectDefined } from "../../test/assertions.js";
import {
  CoreMemoryBlocksSchema,
  coreMemoryWrites,
  createUsageMeter,
  EVAL_MODEL,
  EVAL_PROFILE,
  EvalCoreMemory,
  type EvalTurn,
  LIVE_API_KEY,
  oneLine,
  runEvalConversation,
  runEvalTurn,
} from "../../test/live-eval.js";
import { createTestDatabase } from "../../test/pglite.js";
import type { CoreMemoryBlock } from "../service.js";
import { DrizzleAgentStore } from "../store/index.js";
import { type ExtractionResult, extractCorrections } from "./extract-corrections.js";

const CheckSchema = z.enum(["no-list-lines", "no-imperial-units", "no-closing-offer", "no-bold"]);
type Check = z.infer<typeof CheckSchema>;

const EvalFileSchema = z.object({
  established: CoreMemoryBlocksSchema,
  scenarios: z.array(
    z.object({
      id: z.string(),
      first: z.array(z.string()).min(2),
      second: z.array(z.string()).min(2),
      probe: z.string(),
      check: CheckSchema,
      note: z.string(),
    }),
  ),
});

type Scenario = z.infer<typeof EvalFileSchema>["scenarios"][number];

const EVAL = EvalFileSchema.parse(
  JSON.parse(
    readFileSync(join(process.cwd(), "test/fixtures/evals/correction-learning.json"), "utf8"),
  ),
);

const ONLY = process.env.EVAL_CASES?.split(",").map((id) => id.trim());

const SCENARIOS = EVAL.scenarios.filter((s) => ONLY === undefined || ONLY.includes(s.id));

/** The model `runObserver` extracts on for the seeded profile. */
const EXTRACTION_MODEL = EVAL_PROFILE.extractionModel ?? EVAL_PROFILE.model;

/** The conversation's active channels, as the Observer and the rule lookup see them. */
const CHANNEL_TYPES = ["telegram"];

function lastLine(reply: string): string {
  const lines = reply.split("\n").filter((line) => line.trim() !== "");
  return (lines.at(-1) ?? "").replace(/[*_\s]+$/, "");
}

/** Whether a reply follows the correction. */
const CHECKS: Record<Check, (reply: string) => boolean> = {
  "no-list-lines": (reply) => !/^\s*(?:[-*•+]|\d+[.)])\s+\S/m.test(reply),
  "no-imperial-units": (reply) =>
    !/\b(?:miles?|feet|foot|ft|inch(?:es)?|lbs?|mph)\b|°\s?F\b|\bfahrenheit\b/i.test(reply),
  "no-closing-offer": (reply) => {
    const last = lastLine(reply);
    return (
      !last.endsWith("?") &&
      !/\b(?:let me know|want me to|would you like|shall I|happy to|if you'd like|if you want)\b/i.test(
        last,
      )
    );
  },
  "no-bold": (reply) => !/\*\*[^*\n]+\*\*|__[^_\n]+__/.test(reply),
};

interface StoredCorrection {
  rule: string;
  category: string;
  active: boolean;
  observationCount: number;
  channelType: string | null;
}

interface Probe {
  follows: boolean;
  reply: string;
}

interface Outcome {
  scenario: Scenario;
  extracted: { first: ExtractionResult; second: ExtractionResult };
  /** Correction rows after each extraction. */
  stored: { first: ReadonlyArray<StoredCorrection>; second: ReadonlyArray<StoredCorrection> };
  active: ReadonlyArray<{ rule: string }>;
  /** Whether the probe prompt lists the active rules under `# Rules`; undefined with none. */
  rendered: boolean | undefined;
  withRule: Probe | undefined;
  baseline: Probe;
  /** Core-memory writes in each correcting conversation. */
  coreWrites: { first: ReadonlyArray<CoreMemoryBlock>; second: ReadonlyArray<CoreMemoryBlock> };
}

const outcomes = new Map<string, Outcome>();
/** Scenarios that threw, with the stage they reached. */
const failures = new Map<string, string>();
const usage = createUsageMeter();

function probeOf(turn: EvalTurn, check: Check): Probe {
  return { follows: CHECKS[check](turn.result.text), reply: turn.result.text };
}

function rulesSection(rules: ReadonlyArray<{ rule: string }>): string {
  return `# Rules\n\n${rules.map((r) => `- ${r.rule}`).join("\n")}`;
}

/** Summary rates: each counts the outcomes in `of` for which `hit` holds. */
const METRICS: ReadonlyArray<{
  name: string;
  of: (o: Outcome) => boolean;
  hit: (o: Outcome) => boolean;
}> = [
  { name: "extracted from the first", of: () => true, hit: (o) => o.extracted.first.extracted > 0 },
  {
    name: "matched in the second",
    of: (o) => o.extracted.first.extracted > 0,
    hit: (o) => o.extracted.second.reinforced > 0,
  },
  { name: "rule active", of: () => true, hit: (o) => o.active.length > 0 },
  {
    name: "rendered under # Rules",
    of: (o) => o.active.length > 0,
    hit: (o) => o.rendered === true,
  },
  {
    name: "probe follows, with the rule",
    of: (o) => o.withRule !== undefined,
    hit: (o) => o.withRule?.follows === true,
  },
  { name: "probe follows, baseline", of: () => true, hit: (o) => o.baseline.follows },
  {
    name: "also written to core memory",
    of: () => true,
    hit: (o) => o.coreWrites.first.length + o.coreWrites.second.length > 0,
  },
];

function counts(r: ExtractionResult): string {
  return (
    `new=${r.extracted} reinforced=${r.reinforced} promoted=${r.promoted} ` +
    `contradictions=${r.contradictions} skipped=${r.outOfScopeReinforcementsSkipped + r.unknownRuleReinforcementsSkipped}`
  );
}

function stored(rows: ReadonlyArray<StoredCorrection>): string {
  return rows
    .map(
      (r) =>
        `[${r.active ? "active" : "learning"} ×${r.observationCount} ${r.category} ` +
        `${r.channelType ?? "all channels"}] ${r.rule}`,
    )
    .join("\n         ");
}

function report(): void {
  const rows = SCENARIOS.flatMap((s) => {
    const o = outcomes.get(s.id);
    return o ? [o] : [];
  });
  if (rows.length === 0 && failures.size === 0) return;

  console.log(`\nCorrection → steering rule → followed, on ${EVAL_MODEL}\n`);
  for (const [id, failure] of failures) console.log(`${id}: FAILED ${failure}`);
  for (const o of rows) {
    const follows = (p: Probe | undefined) =>
      p === undefined ? "n/a" : p.follows ? "follows" : "VIOLATES";
    console.log(
      `${o.scenario.id}: rule=${follows(o.withRule)} baseline=${follows(o.baseline)} ` +
        `rendered=${o.rendered ?? "n/a"}`,
    );
    console.log(`  first:  ${counts(o.extracted.first)}`);
    console.log(`         ${stored(o.stored.first) || "(no corrections)"}`);
    console.log(`  second: ${counts(o.extracted.second)}`);
    console.log(`         ${stored(o.stored.second) || "(no corrections)"}`);
    for (const [conversation, writes] of Object.entries(o.coreWrites)) {
      for (const w of writes) {
        console.log(`  core memory (${conversation}): ${w.key} := ${oneLine(w.content, 200)}`);
      }
    }
    if (o.withRule) console.log(`  reply (rule):     ${oneLine(o.withRule.reply, 200)}`);
    console.log(`  reply (baseline): ${oneLine(o.baseline.reply, 200)}`);
  }

  console.table(
    Object.fromEntries(
      METRICS.map((m) => {
        const population = rows.filter(m.of);
        return [m.name, { all: `${population.filter(m.hit).length}/${population.length}` }];
      }),
    ),
  );
  console.log(`Usage: ${usage.summary()}`);
}

function expectCompleted(turns: ReadonlyArray<EvalTurn>): void {
  for (const t of turns) {
    expect(t.result.degraded).toBeUndefined();
    expect(t.result.text).not.toBe("");
  }
}

describe.skipIf(LIVE_API_KEY === undefined)(
  `correction learning on ${EVAL_MODEL} (live eval)`,
  () => {
    const nonce = randomUUID();

    afterAll(report);

    it.concurrent.each(SCENARIOS)(
      "$id",
      async (scenario) => {
        const provider = new AnthropicProvider(expectDefined(LIVE_API_KEY, "API key"));
        const db = await createTestDatabase();
        let stage = "";
        try {
          const store = new DrizzleAgentStore();
          const activeRules = () =>
            db.tx((tx) => store.getActiveRules(tx, EVAL_PROFILE.id, CHANNEL_TYPES));
          const corrections = async () =>
            (await db.tx((tx) => store.getCorrections(tx, EVAL_PROFILE.id))).map(
              ({ id: _id, ...row }) => row,
            );

          /** One correcting conversation, then the Observer's extraction on its transcript. */
          const learnFrom = async (messages: ReadonlyArray<string>, label: string) => {
            stage = `in the ${label} conversation`;
            const conversation = await runEvalConversation({
              provider,
              coreMemory: new EvalCoreMemory(EVAL.established),
              rules: await activeRules(),
              messages,
              cacheKey: `${nonce}-${scenario.id}-${label}`,
            });
            for (const t of conversation.turns) usage.add(t.result.usage);
            expectCompleted(conversation.turns);
            stage = `in the ${label} extraction`;
            const extracted = await extractCorrections(conversation.history, EVAL_PROFILE.id, {
              provider: usage.metered(provider),
              model: EXTRACTION_MODEL,
              runInTx: db.tx,
              store,
              activeChannelTypes: CHANNEL_TYPES,
            });
            return {
              extracted,
              stored: await corrections(),
              coreWrites: coreMemoryWrites(conversation.history),
            };
          };

          const first = await learnFrom(scenario.first, "first");
          const second = await learnFrom(scenario.second, "second");
          const active = await activeRules();

          stage = "in the probes";
          const probe = (rules: ReadonlyArray<{ rule: string }>, label: string) =>
            runEvalTurn({
              provider,
              coreMemory: new EvalCoreMemory(EVAL.established),
              rules,
              history: [],
              message: scenario.probe,
              cacheKey: `${nonce}-${scenario.id}-${label}`,
            });
          const [withRule, baseline] = await Promise.all([
            active.length > 0 ? probe(active, "rule") : undefined,
            probe([], "baseline"),
          ]);
          const probes = withRule ? [withRule, baseline] : [baseline];
          for (const p of probes) usage.add(p.result.usage);

          outcomes.set(scenario.id, {
            scenario,
            extracted: { first: first.extracted, second: second.extracted },
            stored: { first: first.stored, second: second.stored },
            active,
            rendered: withRule?.systemPrompt.includes(rulesSection(active)),
            withRule: withRule && probeOf(withRule, scenario.check),
            baseline: probeOf(baseline, scenario.check),
            coreWrites: { first: first.coreWrites, second: second.coreWrites },
          });

          expectCompleted(probes);
        } catch (err) {
          failures.set(scenario.id, `${stage}: ${oneLine(String(err), 300)}`);
          throw err;
        } finally {
          await db.close();
        }
      },
      600_000,
    );
  },
);
