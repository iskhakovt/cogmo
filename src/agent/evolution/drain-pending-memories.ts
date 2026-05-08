/**
 * Pending memory drain — classifies and retains rows from the
 * `pending_memories` staging table.
 *
 * Exposes three primitives so an Inngest function can wrap each in its
 * own `step.run`, making the classifier results and the Hindsight
 * retain durably memoized:
 *
 *   1. `classifyPendingMemories` — runs the classifier prompt over a
 *      batch of pending rows, bounded concurrency.
 *   2. `buildRetainItems` — pure mapping from classified rows to
 *      `RetainBatchItem`s.
 *   3. `drainPendingMemories` — convenience wrapper composing all
 *      three for non-Inngest callers (tests, scripts).
 *
 * Failures on a single classification are skipped (row left in the
 * table for the next drain attempt). retainBatch is treated as atomic
 * — a batch failure leaves every row pending and rethrows.
 */

import * as R from "remeda";
import type { Transactor } from "../../db/index.js";
import type { LlmProvider } from "../../llm/provider.js";
import { chatTyped } from "../../llm/typed.js";
import { logger } from "../../logger.js";
import type { MemoryProvider, RetainBatchItem } from "../../memory/provider.js";
import type { AgentStore, PendingMemory, PendingMemorySource } from "../store/index.js";
import {
  type ClassifiedMemory,
  ClassifiedMemorySchema,
  PENDING_CLASSIFICATION_PROMPT,
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
}

export interface DrainPendingDeps extends ClassifyDeps {
  runInTx: Transactor;
  memory: Pick<MemoryProvider, "retainBatch">;
  store: Pick<AgentStore, "getPendingMemories" | "deletePendingMemories">;
}

export interface DrainPendingResult {
  drained: number;
  byNetwork: Record<string, number>;
}

/** A pending row with its assigned classification — intentionally JSON-safe so it survives Inngest step memoization. */
export interface ClassifiedRow {
  id: string;
  content: string;
  context: string | null;
  source: PendingMemorySource;
  tags: ClassifiedMemory;
}

export interface ClassifyPendingResult {
  successful: ClassifiedRow[];
  byNetwork: Record<string, number>;
}

/**
 * Subset of `PendingMemory` the classifier actually reads. Declared
 * separately so callers can pass rows that have already been through
 * Inngest step memoization (where `createdAt` is a JSON string, not a
 * `Date`) — we don't use the timestamp here.
 */
export type ClassifierInput = Pick<PendingMemory, "id" | "content" | "context" | "source">;

/** Run the classifier prompt over a batch of pending rows. Single-row failures are skipped, not propagated. */
export async function classifyPendingMemories(
  pending: ReadonlyArray<ClassifierInput>,
  deps: ClassifyDeps,
): Promise<ClassifyPendingResult> {
  const classified: Array<ClassifiedRow | null> = [];
  for (const chunk of R.chunk([...pending], CLASSIFIER_CONCURRENCY)) {
    const results = await Promise.all(chunk.map((p) => classifyOne(p, deps)));
    classified.push(...results);
  }
  const successful = R.filter(classified, (c): c is ClassifiedRow => c !== null);
  const byNetwork = R.countBy(successful, (c) => c.tags.network);
  return { successful, byNetwork };
}

/**
 * Map classified rows to `RetainBatchItem`s. `metadata.source` carries the
 * staging origin so live retains and migrations stay distinguishable from
 * transcript extractions.
 *
 * `profileClass` is the conversation's active profile's `profile_class`
 * value (or `null` if unclassed). When non-null it's emitted as a
 * `profile_class:<class>` tag on every retained memory. The class is taken
 * from the conv's CURRENT profile at drain time — not from the original
 * staging context — because pending rows don't track which profile staged
 * them. For the live-retain path this matches the speaker who's still in
 * the conversation; for migration-staged rows it aligns the backfill with
 * the user's current speaker setup.
 */
export function buildRetainItems(
  rows: ReadonlyArray<ClassifiedRow>,
  profileClass: string | null,
): RetainBatchItem[] {
  return rows.map((r) => ({
    content: r.content,
    ...(r.context !== null && { context: r.context }),
    tags: [
      `network:${r.tags.network}`,
      `compartment:${r.tags.compartment}`,
      `trust:${r.tags.trust}`,
      ...(profileClass !== null ? [`profile_class:${profileClass}`] : []),
    ],
    metadata: { source: r.source },
    observationScopes: "per_tag" as const,
  }));
}

export async function drainPendingMemories(
  userId: string,
  profileClass: string | null,
  deps: DrainPendingDeps,
): Promise<DrainPendingResult> {
  const pending = await deps.runInTx((tx) => deps.store.getPendingMemories(tx, userId));
  if (pending.length === 0) {
    logger.debug({ userId }, "no pending memories to drain");
    return { drained: 0, byNetwork: {} };
  }

  const { successful, byNetwork } = await classifyPendingMemories(pending, {
    provider: deps.provider,
    model: deps.model,
  });

  if (successful.length === 0) {
    logger.warn({ userId, pendingCount: pending.length }, "all pending classifications failed");
    return { drained: 0, byNetwork: {} };
  }

  const items = buildRetainItems(successful, profileClass);
  await deps.memory.retainBatch(userId, items);
  await deps.runInTx((tx) =>
    deps.store.deletePendingMemories(
      tx,
      successful.map((c) => c.id),
    ),
  );

  logger.info({ drained: successful.length, byNetwork, userId }, "pending memory drain complete");

  return { drained: successful.length, byNetwork };
}

async function classifyOne(p: ClassifierInput, deps: ClassifyDeps): Promise<ClassifiedRow | null> {
  try {
    const { data } = await chatTyped({
      provider: deps.provider,
      model: deps.model,
      system: PENDING_CLASSIFICATION_PROMPT,
      messages: [{ role: "user", content: formatForClassifier(p) }],
      schema: ClassifiedMemorySchema,
      name: "pending-memory-classification",
    });
    return {
      id: p.id,
      content: p.content,
      context: p.context,
      source: p.source,
      tags: data,
    };
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
