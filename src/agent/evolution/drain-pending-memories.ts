/**
 * Pending memory drain — classifies and retains rows from the
 * `pending_memories` staging table.
 *
 * Observer runs this after transcript extraction. Each pending row is
 * classified independently (network + compartment + trust) via
 * `chatTyped()`, retained to Hindsight in a single batch, and the row
 * is then deleted from the staging table.
 *
 * Failures on a single row are skipped (left in the table for the next
 * drain attempt) so a transient classifier error doesn't block other
 * rows. retainBatch is treated as atomic — a batch failure leaves
 * every row pending.
 */

import * as R from "remeda";
import type { LlmProvider } from "../../llm/provider.js";
import { chatTyped } from "../../llm/typed.js";
import { logger } from "../../logger.js";
import type { MemoryProvider, RetainBatchItem } from "../../memory/provider.js";
import type { AgentStore, PendingMemory } from "../store/index.js";
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

export interface DrainPendingDeps {
  provider: LlmProvider;
  model: string;
  memory: Pick<MemoryProvider, "retainBatch">;
  store: Pick<AgentStore, "getPendingMemories" | "deletePendingMemories">;
}

export interface DrainPendingResult {
  drained: number;
  byNetwork: Record<string, number>;
}

interface ClassifiedPending {
  pending: PendingMemory;
  tags: ClassifiedMemory;
}

export async function drainPendingMemories(
  userId: string,
  deps: DrainPendingDeps,
): Promise<DrainPendingResult> {
  const pending = await deps.store.getPendingMemories(userId);
  if (pending.length === 0) {
    logger.debug({ userId }, "no pending memories to drain");
    return { drained: 0, byNetwork: {} };
  }

  const classified: Array<ClassifiedPending | null> = [];
  for (const chunk of R.chunk(pending, CLASSIFIER_CONCURRENCY)) {
    const results = await Promise.all(chunk.map((p) => classifyOne(p, deps)));
    classified.push(...results);
  }
  const successful = R.filter(classified, (c): c is ClassifiedPending => c !== null);

  if (successful.length === 0) {
    logger.warn({ userId, pendingCount: pending.length }, "all pending classifications failed");
    return { drained: 0, byNetwork: {} };
  }

  const items: RetainBatchItem[] = successful.map(({ pending: p, tags }) => ({
    content: p.content,
    ...(p.context !== null && { context: p.context }),
    tags: [`network:${tags.network}`, `compartment:${tags.compartment}`, `trust:${tags.trust}`],
    metadata: { source: p.source === "migration" ? "migration" : "conversation" },
    observationScopes: "per_tag" as const,
  }));

  await deps.memory.retainBatch(userId, items);
  await deps.store.deletePendingMemories(successful.map(({ pending: p }) => p.id));

  const byNetwork = R.countBy(successful, (c) => c.tags.network);
  logger.info({ drained: successful.length, byNetwork, userId }, "pending memory drain complete");

  return { drained: successful.length, byNetwork };
}

async function classifyOne(
  p: PendingMemory,
  deps: DrainPendingDeps,
): Promise<ClassifiedPending | null> {
  try {
    const { data } = await chatTyped({
      provider: deps.provider,
      model: deps.model,
      system: PENDING_CLASSIFICATION_PROMPT,
      messages: [{ role: "user", content: formatForClassifier(p) }],
      schema: ClassifiedMemorySchema,
      name: "pending-memory-classification",
    });
    return { pending: p, tags: data };
  } catch (err) {
    logger.warn({ err, pendingId: p.id }, "pending classification failed — row left in table");
    return null;
  }
}

function formatForClassifier(p: PendingMemory): string {
  if (p.context !== null && p.context.length > 0) {
    return `Fact: ${p.content}\nContext: ${p.context}`;
  }
  return `Fact: ${p.content}`;
}
