/**
 * Pending memory drain — classifies and retains rows from the
 * `pending_memories` staging table.
 *
 * Exposes three primitives so an Inngest function can wrap each in its
 * own `step.run`, making the classifier results and the Hindsight
 * retain durably memoized:
 *
 *   1. `loadPendingBatch` — reads the rows the fire may classify.
 *   2. `classifyPendingMemories` — runs the classifier prompt over a
 *      batch of pending rows, bounded concurrency, and withholds a row a
 *      `memory`-category rule forbids.
 *   3. `buildRetainItems` — pure mapping from classified rows to
 *      `RetainBatchItem`s.
 *   4. `drainPendingMemories` — convenience wrapper composing them for
 *      non-Inngest callers (tests, scripts).
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
  bindsUnseenUserRule,
  type MemoryRule,
  memoryRulesFor,
  type PendingMemory,
  type PendingMemoryFilter,
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

/** The Observer fire a drain or an extraction runs in. */
export interface ObserverFire {
  conversationId: string;
  userId: string;
  /** The conversation's profile, whose model classifies and extracts. */
  profileId: string;
  /**
   * Whether that profile sees the user's instruction rules and first-party
   * staged facts (`admitsFirstParty`). A third-party fire's model classifies
   * only rows its own profile staged, and none a user's rule it can't see
   * binds; the rest wait for a first-party fire.
   */
  seesUserRules: boolean;
}

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
  fire: ObserverFire;
  runInTx: Transactor;
  /**
   * Reads the `memory`-category rules each row's staging profile sees, and
   * the staging profile of a replayed row that lacks it.
   */
  store: Pick<AgentStore, "getMemoryRules" | "getPendingMemories">;
}

export interface DrainPendingDeps extends ClassifyDeps {
  memory: Pick<MemoryProvider, "retainBatch">;
  store: Pick<
    AgentStore,
    "getPendingMemories" | "countPendingMemories" | "deletePendingMemories" | "getMemoryRules"
  >;
}

export interface DrainPendingResult {
  drained: number;
  byNetwork: Record<string, number>;
  /** Rows a memory rule forbids, deleted without a retain. */
  withheld: number;
  /** Rows left pending for a first-party fire: see `ObserverFire.seesUserRules`. */
  deferredToFirstParty: number;
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
  /** Rows of the batch left pending, unclassified, for a first-party fire. */
  deferredToFirstParty: number;
}

/** The rows one drain classifies, and how many it leaves for a first-party fire. */
export interface PendingBatch {
  pending: ReadonlyArray<PendingMemory>;
  deferredToFirstParty: number;
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
 * Read the oldest `limit` rows the fire may classify. A first-party fire takes
 * every row of the user. A third-party fire takes only rows its own profile
 * staged, and none of those a user's rule its model can't see binds; it
 * counts the rest as deferred. The filter applies before the limit, so
 * deferred rows never fill a third-party fire's batch.
 */
export async function loadPendingBatch(
  fire: ObserverFire,
  limit: number | undefined,
  deps: { runInTx: Transactor; store: DrainPendingDeps["store"] },
): Promise<PendingBatch> {
  return deps.runInTx(async (tx) => {
    if (fire.seesUserRules) {
      return {
        pending: await deps.store.getPendingMemories(tx, fire.userId, limit),
        deferredToFirstParty: 0,
      };
    }
    const rules = await deps.store.getMemoryRules(tx, {
      profileIds: [fire.profileId],
      userId: fire.userId,
    });
    const filter: PendingMemoryFilter = {
      stagedBy: fire.profileId,
      ...(bindsUnseenUserRule(rules, fire.seesUserRules) && { sources: ["migration"] as const }),
    };
    const pending = await deps.store.getPendingMemories(tx, fire.userId, limit, filter);
    const all = await deps.store.countPendingMemories(tx, fire.userId);
    const eligible = await deps.store.countPendingMemories(tx, fire.userId, filter);
    const deferredToFirstParty = all - eligible;
    if (deferredToFirstParty > 0) {
      logger.info(
        { ...fire, deferredToFirstParty },
        "pending rows left for a first-party fire — a third-party profile's model doesn't classify them",
      );
    }
    return { pending, deferredToFirstParty };
  });
}

/**
 * Run the classifier prompt over a batch of pending rows. A `live_retain` or
 * `skill` row is classified under the `memory`-category rules its staging
 * profile sees, and withheld when one forbids it; a `migration` row is a
 * restaged memory and passes. A row that is no longer pending is skipped, and
 * one a third-party fire may not classify (as `loadPendingBatch` filters, for
 * a batch read without that filter) is deferred. Single-row failures are
 * skipped, not propagated.
 */
export async function classifyPendingMemories(
  pending: ReadonlyArray<ClassifierInput>,
  deps: ClassifyDeps,
): Promise<ClassifyPendingResult> {
  const { fire } = deps;
  const customNames = deps.customCompartments.map((c) => c.name);
  const schemas = {
    plain: buildClassifiedMemorySchema(customNames),
    withholding: buildWithholdingClassifiedMemorySchema(customNames),
  };
  const { stagingOf, rulesOf } = await loadMemoryRules(pending, deps);
  const [deferred, classifiable] = R.partition(pending, (p) => {
    const staging = stagingOf(p);
    if (staging === undefined || fire.seesUserRules) return false;
    return staging !== fire.profileId || bindsUnseenUserRule(rulesOf(p), fire.seesUserRules);
  });
  if (deferred.length > 0) {
    logger.info(
      { ...fire, pendingIds: deferred.map((p) => p.id) },
      "pending rows left for a first-party fire — a third-party profile's model doesn't classify them",
    );
  }
  const classified: Array<ClassifiedOutcome | null> = [];
  for (const chunk of R.chunk(classifiable, CLASSIFIER_CONCURRENCY)) {
    const results = await Promise.all(
      chunk.map((p) => {
        if (stagingOf(p) === undefined) {
          logger.info({ pendingId: p.id }, "pending row gone before classification — skipped");
          return null;
        }
        return classifyOne(p, rulesOf(p), schemas, deps);
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
  return {
    successful,
    withheld: withheldOutcomes.map((c) => c.row.id),
    byNetwork,
    deferredToFirstParty: deferred.length,
  };
}

/**
 * Each row's staging profile and the memory rules it is classified under,
 * from one read: no rules for a `migration` row, its staging profile's for
 * the rest. A replayed row memoized without `profileId` has it `undefined`;
 * its staging profile is read again, for those ids only, and one no longer
 * pending reads as `undefined`. A row that kept its `profileId` isn't
 * checked: one deleted meanwhile is classified again, and its retain
 * replaces the same document.
 */
async function loadMemoryRules(
  pending: ReadonlyArray<ClassifierInput>,
  deps: Pick<ClassifyDeps, "fire" | "runInTx" | "store">,
): Promise<{
  stagingOf: (p: ClassifierInput) => string | null | undefined;
  rulesOf: (p: ClassifierInput) => ReadonlyArray<MemoryRule>;
}> {
  const { userId } = deps.fire;
  const unresolved = pending.filter((p) => p.profileId === undefined).map((p) => p.id);
  const { reread, rules } = await deps.runInTx(async (tx) => {
    const reread =
      unresolved.length === 0
        ? new Map<string, string | null>()
        : new Map(
            (await deps.store.getPendingMemories(tx, userId, undefined, { ids: unresolved })).map(
              (r) => [r.id, r.profileId],
            ),
          );
    const staging = pending.map((p) =>
      p.profileId === undefined ? reread.get(p.id) : p.profileId,
    );
    const profileIds = R.unique(staging.filter((id) => typeof id === "string"));
    const bound = pending.some((p) => p.source !== "migration");
    return {
      reread,
      rules: bound ? await deps.store.getMemoryRules(tx, { profileIds, userId }) : [],
    };
  });
  const stagingOf = (p: ClassifierInput) =>
    p.profileId === undefined ? reread.get(p.id) : p.profileId;
  return {
    stagingOf,
    rulesOf: (p) => {
      const staging = stagingOf(p);
      return p.source === "migration" || staging === undefined
        ? []
        : memoryRulesFor(rules, staging);
    },
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

export async function drainPendingMemories(deps: DrainPendingDeps): Promise<DrainPendingResult> {
  const { userId } = deps.fire;
  const batch = await loadPendingBatch(deps.fire, undefined, deps);
  if (batch.pending.length === 0) {
    logger.debug({ userId }, "no pending memories to drain");
    return {
      drained: 0,
      byNetwork: {},
      withheld: 0,
      deferredToFirstParty: batch.deferredToFirstParty,
    };
  }

  const classified = await classifyPendingMemories(batch.pending, deps);
  const { successful, withheld, byNetwork } = classified;
  const deferredToFirstParty = batch.deferredToFirstParty + classified.deferredToFirstParty;

  if (successful.length === 0 && withheld.length === 0) {
    if (batch.pending.length > classified.deferredToFirstParty) {
      logger.warn({ userId, pendingCount: batch.pending.length }, "no pending row classified");
    }
    return { drained: 0, byNetwork: {}, withheld: 0, deferredToFirstParty };
  }

  if (successful.length > 0) {
    await deps.memory.retainBatch(userId, buildRetainItems(successful));
  }
  await deps.runInTx((tx) =>
    deps.store.deletePendingMemories(tx, [...successful.map((c) => c.id), ...withheld]),
  );

  logger.info(
    {
      drained: successful.length,
      withheld: withheld.length,
      deferredToFirstParty,
      byNetwork,
      userId,
    },
    "pending memory drain complete",
  );

  return {
    drained: successful.length,
    byNetwork,
    withheld: withheld.length,
    deferredToFirstParty,
  };
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
