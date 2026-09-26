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
 * `DrizzleAgentStore` to a PGlite database of the sample's own. The second
 * extraction sees the first one's rule, so graduation depends on the model
 * matching it. Then a probe message opens a fresh conversation, once with the
 * active rules in the prompt and once without the correction as a baseline,
 * and a deterministic check on what each reply showed the user says whether it
 * follows the correction.
 *
 * The conversation is on Telegram, so each database starts with the channel
 * rules `seedChannelRules` gives a Telegram setup ("Use bullet lists instead"
 * of tables among them), and every prompt's `# Rules` carries them as
 * production's would: the baseline probe has those alone, the other probe
 * those plus the active corrections. Every conversation, the probes included,
 * starts from the fixture's established blocks, so the probe measures the
 * rule alone. The agent may also save the correction to core memory as a
 * standing preference; those writes are reported, not carried forward.
 *
 * Like the other evals it reports rather than asserts, and fails only when a
 * turn or an extraction does not complete.
 *
 * Skipped unless `LIVE=1` and `ANTHROPIC_API_KEY` are set. A full run is 24
 * turns and 8 extractions on Sonnet 5, about $0.45.
 *
 *   set -a; . ./.env; set +a; LIVE=1 pnpm test:live src/agent/evolution/correction-learning.live.test.ts
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
import { AnthropicProvider } from "../../llm/anthropic.js";
import { seedChannelRules } from "../../setup/seed.js";
import { expectDefined } from "../../test/assertions.js";
import { REPLY_CHECKS, type ReplyCheck, wordCount } from "../../test/eval-checks.js";
import {
  CoreMemoryBlocksSchema,
  coreMemoryWrites,
  createUsageMeter,
  EVAL_MODEL,
  EVAL_PROFILE,
  EVAL_REPEATS,
  EvalCoreMemory,
  type EvalFailure,
  type EvalMetric,
  type EvalTurn,
  isFailure,
  LIVE_API_KEY,
  oneLine,
  rateTable,
  runEvalConversation,
  runEvalTurn,
  shownText,
  withRepeats,
} from "../../test/live-eval.js";
import { createTestDatabase } from "../../test/pglite.js";
import type { CoreMemoryBlock } from "../service.js";
import { DrizzleAgentStore } from "../store/index.js";
import { type ExtractionResult, extractCorrections } from "./extract-corrections.js";

const CheckSchema = z.enum([
  "no-list-lines",
  "no-imperial-units",
  "max-100-words",
  "no-bold",
]) satisfies z.ZodType<ReplyCheck>;

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

const CHANNEL = "telegram";

/** The conversation's active channels, as the Observer and the rule lookup see them. */
const CHANNEL_TYPES = [CHANNEL];

interface StoredCorrection {
  rule: string;
  category: string;
  active: boolean;
  observationCount: number;
  channelType: string | null;
}

interface Probe {
  follows: boolean;
  words: number;
  reply: string;
}

interface Outcome {
  repeat: number;
  scenario: Scenario;
  extracted: { first: ExtractionResult; second: ExtractionResult };
  /** Correction rows after each extraction. */
  stored: { first: ReadonlyArray<StoredCorrection>; second: ReadonlyArray<StoredCorrection> };
  /** Correction rows active after the second extraction. */
  activeCorrections: ReadonlyArray<StoredCorrection>;
  /** Whether the probe's `# Rules` lists every active correction; undefined with none. */
  rendered: boolean | undefined;
  withRule: Probe | undefined;
  baseline: Probe;
  /** Core-memory writes in each correcting conversation. */
  coreWrites: { first: ReadonlyArray<CoreMemoryBlock>; second: ReadonlyArray<CoreMemoryBlock> };
}

type Sample = Outcome | (EvalFailure & { scenario: Scenario });

/** Every sample of each scenario, by scenario id. */
const samples = new Map<string, Sample[]>();
const usage = createUsageMeter();

function record(sample: Sample): void {
  samples.set(sample.scenario.id, [...(samples.get(sample.scenario.id) ?? []), sample]);
}

function probeOf(turn: EvalTurn, check: ReplyCheck): Probe {
  const reply = shownText(turn.result);
  return { follows: REPLY_CHECKS[check](reply), words: wordCount(reply), reply };
}

/** The `- rule` lines of the prompt's `# Rules` section. */
function ruleLines(systemPrompt: string): ReadonlyArray<string> {
  const section = systemPrompt.split("\n\n# ").find((part) => part.startsWith("Rules\n\n"));
  return section?.split("\n").filter((line) => line.startsWith("- ")) ?? [];
}

const METRICS: ReadonlyArray<EvalMetric<Outcome>> = [
  { name: "extracted from the first", of: () => true, hit: (o) => o.extracted.first.extracted > 0 },
  {
    name: "matched in the second",
    of: (o) => o.extracted.first.extracted > 0,
    hit: (o) => o.extracted.second.reinforced > 0,
  },
  { name: "correction active", of: () => true, hit: (o) => o.activeCorrections.length > 0 },
  {
    name: "rendered under # Rules",
    of: (o) => o.activeCorrections.length > 0,
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
    .join("\n           ");
}

function follows(p: Probe | undefined): string {
  if (p === undefined) return "n/a";
  return `${p.follows ? "follows" : "VIOLATES"} (${p.words} words)`;
}

function report(): void {
  const byScenario = SCENARIOS.map((scenario) => ({
    scenario,
    samples: R.sortBy(samples.get(scenario.id) ?? [], (o) => o.repeat),
  }));
  const rows = byScenario.flatMap((s) => s.samples);
  if (rows.length === 0) return;

  console.log(
    `\nCorrection → steering rule → followed, on ${EVAL_MODEL}, ${EVAL_REPEATS} sample(s) per scenario\n`,
  );
  for (const { scenario, samples: scenarioSamples } of byScenario) {
    const passes = scenarioSamples.filter(
      (o) => !isFailure(o) && o.withRule?.follows === true,
    ).length;
    console.log(`${passes}/${EVAL_REPEATS} ${scenario.id} (rule active and followed)`);
    for (const o of scenarioSamples) {
      if (isFailure(o)) {
        console.log(`  FAILED #${o.repeat} ${o.failure}`);
        continue;
      }
      console.log(
        `  #${o.repeat} rule=${follows(o.withRule)} baseline=${follows(o.baseline)} ` +
          `rendered=${o.rendered ?? "n/a"}`,
      );
      console.log(`    first:  ${counts(o.extracted.first)}`);
      console.log(`           ${stored(o.stored.first) || "(no corrections)"}`);
      console.log(`    second: ${counts(o.extracted.second)}`);
      console.log(`           ${stored(o.stored.second) || "(no corrections)"}`);
      for (const [conversation, writes] of Object.entries(o.coreWrites)) {
        for (const w of writes) {
          console.log(`    core memory (${conversation}): ${w.key} := ${oneLine(w.content, 200)}`);
        }
      }
      if (o.withRule) console.log(`    reply (rule):     ${oneLine(o.withRule.reply, 200)}`);
      console.log(`    reply (baseline): ${oneLine(o.baseline.reply, 200)}`);
    }
  }

  console.table(rateTable(METRICS, { all: rows }));
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

    it.concurrent.each(withRepeats(SCENARIOS))(
      "$id #$repeat",
      async ({ repeat, ...scenario }) => {
        const provider = new AnthropicProvider(expectDefined(LIVE_API_KEY, "API key"));
        const db = await createTestDatabase();
        let stage = "seeding the channel rules";
        try {
          const store = new DrizzleAgentStore();
          await seedChannelRules(db.tx, store, CHANNEL);
          const activeRules = () =>
            db.tx((tx) => store.getActiveRules(tx, EVAL_PROFILE.id, CHANNEL_TYPES));
          const corrections = async () =>
            (await db.tx((tx) => store.getCorrections(tx, EVAL_PROFILE.id))).map(
              ({ id: _id, ...row }) => row,
            );
          const channelRules = await activeRules();

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
          const activeCorrections = second.stored.filter((r) => r.active);

          stage = "in the probes";
          const probe = async (rules: ReadonlyArray<{ rule: string }>, label: string) =>
            runEvalTurn({
              provider,
              coreMemory: new EvalCoreMemory(EVAL.established),
              rules,
              history: [],
              message: scenario.probe,
              cacheKey: `${nonce}-${scenario.id}-${label}`,
            });
          const [withRule, baseline] = await Promise.all([
            activeCorrections.length > 0 ? activeRules().then((r) => probe(r, "rule")) : undefined,
            probe(channelRules, "baseline"),
          ]);
          const probes = withRule ? [withRule, baseline] : [baseline];
          for (const p of probes) usage.add(p.result.usage);
          expectCompleted(probes);

          const shown = withRule && ruleLines(withRule.systemPrompt);
          record({
            repeat,
            scenario,
            extracted: { first: first.extracted, second: second.extracted },
            stored: { first: first.stored, second: second.stored },
            activeCorrections,
            rendered: shown && activeCorrections.every((r) => shown.includes(`- ${r.rule}`)),
            withRule: withRule && probeOf(withRule, scenario.check),
            baseline: probeOf(baseline, scenario.check),
            coreWrites: { first: first.coreWrites, second: second.coreWrites },
          });
        } catch (err) {
          record({ repeat, scenario, failure: `${stage}: ${oneLine(String(err), 300)}` });
          throw err;
        } finally {
          await db.close();
        }
      },
      600_000,
    );
  },
);
