/**
 * Pending memory drain — classifies and retains rows from the
 * `pending_memories` staging table.
 *
 * Exposes three primitives so an Inngest function can wrap each in its
 * own `step.run`, making the classifier results and the Hindsight
 * retain durably memoized:
 *
 *   1. `classifyPendingMemories` — runs the classifier prompt over a
 *      batch of pending rows, bounded concurrency, and withholds a row a
 *      `memory`-category rule forbids.
 *   2. `buildRetainItems` — pure mapping from classified rows to
 *      `RetainBatchItem`s.
 *   3. `drainPendingMemories` — convenience wrapper composing all
 *      three for non-Inngest callers (tests, scripts).
 *
 * Failures on a single classification are skipped (row left in the
 * table for the next drain attempt). A withheld row is deleted with the
 * retained ones and never retained. retainBatch is treated as atomic
 * — a batch failure leaves every row pending and rethrows. Each row is
 * retained under its id as the document id, so re-draining a row whose
 * delete failed replaces its document rather than duplicating it.
 */

import * as R from "remeda";
import type { Transactor } from "../../db/index.js";
import type { LlmProvider } from "../../llm/provider.js";
import { chatTyped } from "../../llm/typed.js";
import { logger } from "../../logger.js";
import type { MemoryProvider, RetainBatchItem } from "../../memory/provider.js";
import {
  type AgentStore,
  type MemoryRule,
  memoryRulesFor,
  type PendingMemory,
  type PendingMemorySource,
} from "../store/index.js";
import {
  buildClassifiedMemorySchema,
  buildPendingClassificationPrompt,
  buildWithholdingClassifiedMemorySchema,
  type ClassifiedMemory,
  type CompartmentDefinition,
} from "./memory-extraction-schema.js";

/**
 * Max in-flight classifier calls per chunk. Bounds parallelism so a
 * post-migration drain of hundreds of rows doesn't dispatch every
 * request at once and trip provider rate limits.
 */
const CLASSIFIER_CONCURRENCY = 8;

export interface ClassifyDeps {
  provider: LlmProvider;
  model: string;
  /**
   * The user's `custom_compartments` rows at fire time. Templated into the
   * classifier prompt and locked into the structured-output schema. Empty
   * array = core-only. Pre-loaded by the Observer so every row in a batch
   * shares the same schema (one compile per fire, not per row).
   */
  customCompartments: ReadonlyArray<CompartmentDefinition>;
  /**
   * Whether the fire's profile, whose model classifies, sees the user's
   * instruction rules (`admitsFirstParty`). When it doesn't, a row such a
   * rule binds stays pending for a fire whose profile does.
   */
  seesUserRules: boolean;
  runInTx: Transactor;
  /**
   * Reads the `memory`-category rules each row's staging profile sees, and
   * re-reads a row's staging profile when a replayed row lacks it.
   */
  store: Pick<AgentStore, "getMemoryRules" | "getPendingMemories">;
}

export interface DrainPendingDeps extends ClassifyDeps {
  memory: Pick<MemoryProvider, "retainBatch">;
  store: Pick<AgentStore, "getPendingMemories" | "deletePendingMemories" | "getMemoryRules">;
}

export interface DrainPendingResult {
  drained: number;
  byNetwork: Record<string, number>;
  /** Rows a memory rule forbids, deleted without a retain. */
  withheld: number;
}

/**
 * A pending row with its assigned classification — intentionally JSON-safe so
 * it survives Inngest step memoization. `profileClass` is the staging
 * profile's class (carried through from the pending row), so each row in a
 * batch can be tagged with the right `profile_class:<class>` independently of
 * what conversation triggered the drain.
 */
export interface ClassifiedRow {
  id: string;
  content: string;
  context: string | null;
  source: PendingMemorySource;
  profileClass: string | null;
  skillName: string | null;
  tags: ClassifiedMemory;
}

export interface ClassifyPendingResult {
  /** Rows to retain. */
  successful: ClassifiedRow[];
  /** Ids of rows a memory rule forbids: deleted without a retain. */
  withheld: string[];
  byNetwork: Record<string, number>;
}

/**
 * Subset of `PendingMemory` the classifier actually reads. Declared
 * separately so callers can pass rows that have already been through
 * Inngest step memoization (where `createdAt` is a JSON string, not a
 * `Date`) — we don't use the timestamp here. Includes `profileClass` and
 * `skillName`, which the retain step stamps on each row, and `profileId`,
 * whose memory rules the classifier applies.
 */
export type ClassifierInput = Pick<
  PendingMemory,
  "id" | "content" | "context" | "source" | "profileId" | "profileClass" | "skillName"
>;

/**
 * Run the classifier prompt over a batch of pending rows. A `live_retain` or
 * `skill` row is classified under the `memory`-category rules its staging
 * profile sees, and withheld when one forbids it; a `migration` row is a
 * restaged memory and passes. A row stays pending, unclassified, when it is
 * gone or a rule the fire's model may not see binds it. Single-row failures
 * are skipped, not propagated.
 */
export async function classifyPendingMemories(
  pending: ReadonlyArray<ClassifierInput>,
  userId: string,
  deps: ClassifyDeps,
): Promise<ClassifyPendingResult> {
  const customNames = deps.customCompartments.map((c) => c.name);
  const schemas = {
    plain: buildClassifiedMemorySchema(customNames),
    withholding: buildWithholdingClassifiedMemorySchema(customNames),
  };
  const rulesOf = await loadMemoryRules(pending, userId, deps);
  const classified: Array<ClassifiedOutcome | null> = [];
  for (const chunk of R.chunk([...pending], CLASSIFIER_CONCURRENCY)) {
    const results = await Promise.all(
      chunk.map((p) => {
        const rules = rulesOf(p);
        if (rules === undefined) {
          logger.info({ pendingId: p.id }, "pending row gone before classification — skipped");
          return null;
        }
        if (!deps.seesUserRules && rules.some((r) => r.fromUser)) {
          logger.info(
            { pendingId: p.id },
            "pending row bound by a user's memory rule this fire's profile may not see — left pending",
          );
          return null;
        }
        return classifyOne(p, rules, schemas, deps);
      }),
    );
    classified.push(...results);
  }
  const [withheldOutcomes, retained] = R.partition(
    R.filter(classified, (c) => c !== null),
    (c) => c.withhold,
  );
  const successful = retained.map((c) => c.row);
  const byNetwork = R.countBy(successful, (c) => c.tags.network);
  return { successful, withheld: withheldOutcomes.map((c) => c.row.id), byNetwork };
}

/**
 * The memory rules each row is classified under, from one read: none for a
 * `migration` row, its staging profile's for the rest, and `undefined` for a
 * row that is no longer pending. A replayed row memoized without `profileId`
 * has it `undefined`; its staging profile is read again rather than taken as
 * none, which would leave its persona's rules out.
 */
async function loadMemoryRules(
  pending: ReadonlyArray<ClassifierInput>,
  userId: string,
  deps: Pick<ClassifyDeps, "runInTx" | "store">,
): Promise<(p: ClassifierInput) => ReadonlyArray<MemoryRule> | undefined> {
  const bound = pending.filter((p) => p.source !== "migration");
  if (bound.length === 0) return () => [];
  const { staging, rules } = await deps.runInTx(async (tx) => {
    const unresolved = bound.some((p) => p.profileId === undefined);
    const current = unresolved
      ? new Map((await deps.store.getPendingMemories(tx, userId)).map((r) => [r.id, r.profileId]))
      : undefined;
    const staging = new Map(
      bound.flatMap((p): Array<[string, string | null]> => {
        if (p.profileId !== undefined) return [[p.id, p.profileId]];
        const reread = current?.get(p.id);
        return reread === undefined ? [] : [[p.id, reread]];
      }),
    );
    const profileIds = R.unique([...staging.values()].filter((id) => id !== null));
    return { staging, rules: await deps.store.getMemoryRules(tx, { profileIds, userId }) };
  });
  return (p) => {
    if (p.source === "migration") return [];
    const profileId = staging.get(p.id);
    return profileId === undefined ? undefined : memoryRulesFor(rules, profileId);
  };
}

/**
 * Map classified rows to `RetainBatchItem`s. `metadata.source` carries the
 * staging origin so live retains, skill writes and migrations stay
 * distinguishable from transcript extractions; `metadata.skill` names the
 * skill on a `skill` row.
 *
 * Each row's `profile_class:<class>` tag (when present) is taken from
 * `r.profileClass` — the staging profile's CURRENT class, captured by
 * `getPendingMemories`'s LEFT JOIN. This is what makes the speaker
 * isolation correct under multi-profile drains: a row staged by profile
 * A retains its class even if the conversation that triggered Observer
 * runs under profile B. Migration-sourced rows (and rows whose staging
 * profile was deleted) have `profileClass: null` and stamp untagged on
 * the class dimension — their absence from a class-scoped recall is the
 * existing legacy semantic.
 */
export function buildRetainItems(rows: ReadonlyArray<ClassifiedRow>): RetainBatchItem[] {
  return rows.map((r) => ({
    content: r.content,
    documentId: r.id,
    ...(r.context !== null && { context: r.context }),
    tags: [
      `network:${r.tags.network}`,
      `compartment:${r.tags.compartment}`,
      `trust:${r.tags.trust}`,
      // Guard against `undefined` (not just `null`) — Inngest serializes
      // step output to JSON; an in-flight run started under earlier code
      // that didn't include `profileClass` on `ClassifiedRow` will
      // deserialize with `profileClass: undefined` on retry. Bare
      // `!== null` would slip through and emit `profile_class:undefined`.
      ...(typeof r.profileClass === "string" ? [`profile_class:${r.profileClass}`] : []),
    ],
    // `typeof` for the same replay reason as `profileClass`.
    metadata: {
      source: r.source,
      ...(typeof r.skillName === "string" && { skill: r.skillName }),
    },
    observationScopes: "per_tag" as const,
  }));
}

export async function drainPendingMemories(
  userId: string,
  deps: DrainPendingDeps,
): Promise<DrainPendingResult> {
  const pending = await deps.runInTx((tx) => deps.store.getPendingMemories(tx, userId));
  if (pending.length === 0) {
    logger.debug({ userId }, "no pending memories to drain");
    return { drained: 0, byNetwork: {}, withheld: 0 };
  }

  const { successful, withheld, byNetwork } = await classifyPendingMemories(pending, userId, deps);

  if (successful.length === 0 && withheld.length === 0) {
    logger.warn({ userId, pendingCount: pending.length }, "no pending row classified");
    return { drained: 0, byNetwork: {}, withheld: 0 };
  }

  if (successful.length > 0) {
    await deps.memory.retainBatch(userId, buildRetainItems(successful));
  }
  await deps.runInTx((tx) =>
    deps.store.deletePendingMemories(tx, [...successful.map((c) => c.id), ...withheld]),
  );

  logger.info(
    { drained: successful.length, withheld: withheld.length, byNetwork, userId },
    "pending memory drain complete",
  );

  return { drained: successful.length, byNetwork, withheld: withheld.length };
}

interface ClassifiedOutcome {
  row: ClassifiedRow;
  /** A listed memory rule forbids storing the row. */
  withhold: boolean;
}

async function classifyOne(
  p: ClassifierInput,
  rules: ReadonlyArray<MemoryRule>,
  schemas: {
    plain: ReturnType<typeof buildClassifiedMemorySchema>;
    withholding: ReturnType<typeof buildWithholdingClassifiedMemorySchema>;
  },
  deps: Pick<ClassifyDeps, "provider" | "model" | "customCompartments">,
): Promise<ClassifiedOutcome | null> {
  const memoryRules = rules.map((r) => r.rule);
  const request = {
    provider: deps.provider,
    model: deps.model,
    system: buildPendingClassificationPrompt(deps.customCompartments, memoryRules),
    messages: [{ role: "user" as const, content: formatForClassifier(p) }],
    name: "pending-memory-classification",
    repair: {},
  };
  try {
    const { withhold, ...tags } =
      memoryRules.length > 0
        ? (await chatTyped({ ...request, schema: schemas.withholding })).data
        : { ...(await chatTyped({ ...request, schema: schemas.plain })).data, withhold: false };
    const row: ClassifiedRow = {
      id: p.id,
      content: p.content,
      context: p.context,
      source: p.source,
      profileClass: p.profileClass,
      skillName: p.skillName,
      tags,
    };
    if (withhold) {
      // The fact itself stays out of the log, as every other drain log keeps it.
      logger.info(
        {
          pendingId: p.id,
          source: p.source,
          ...(typeof p.skillName === "string" && { skill: p.skillName }),
          memoryRules,
        },
        "pending memory withheld by a memory rule — deleted without a retain",
      );
    }
    return { row, withhold };
  } catch (err) {
    logger.warn({ err, pendingId: p.id }, "pending classification failed — row left in table");
    return null;
  }
}

function formatForClassifier(p: ClassifierInput): string {
  if (p.context !== null && p.context.length > 0) {
    return `Fact: ${p.content}\nContext: ${p.context}`;
  }
  return `Fact: ${p.content}`;
}
