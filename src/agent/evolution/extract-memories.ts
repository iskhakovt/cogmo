/**
 * Memory extraction — pure function with injected dependencies.
 *
 * Analyzes a conversation transcript for facts worth remembering,
 * classifies each into a memory network, and retains them to Hindsight
 * with network tags and per-tag observation scoping.
 */

import type { LlmProvider } from "../../llm/provider.js";
import { chatTyped } from "../../llm/typed.js";
import type { Message } from "../../llm/types.js";
import { logger } from "../../logger.js";
import type { MemoryProvider, RetainBatchItem } from "../../memory/provider.js";
import { formatTranscript } from "./extract-corrections.js";
import { MEMORY_EXTRACTION_PROMPT, MemoryExtractionSchema } from "./memory-extraction-schema.js";

export interface MemoryExtractionDeps {
  provider: LlmProvider;
  model: string;
  memory: Pick<MemoryProvider, "retainBatch">;
}

export interface MemoryExtractionResult {
  extracted: number;
  byNetwork: Record<string, number>;
}

/**
 * Extract facts from a conversation transcript and retain them to memory.
 *
 * Returns counts of what was extracted. Pure function — all I/O goes through deps.
 */
export async function extractMemories(
  history: ReadonlyArray<Message>,
  bankId: string,
  deps: MemoryExtractionDeps,
): Promise<MemoryExtractionResult> {
  const transcript = formatTranscript(history);

  if (transcript.trim().length === 0) {
    logger.debug("empty transcript — skipping memory extraction");
    return { extracted: 0, byNetwork: {} };
  }

  const { data } = await chatTyped({
    provider: deps.provider,
    model: deps.model,
    system: MEMORY_EXTRACTION_PROMPT,
    messages: [{ role: "user", content: transcript }],
    schema: MemoryExtractionSchema,
    name: "memory-extraction",
  });

  if (data.memories.length === 0) {
    logger.debug("no memories extracted from transcript");
    return { extracted: 0, byNetwork: {} };
  }

  const items: RetainBatchItem[] = data.memories.map((mem) => ({
    content: mem.fact,
    ...(mem.context !== undefined && { context: mem.context }),
    tags: [`network:${mem.network}`],
    metadata: { source: "conversation" },
    observationScopes: "per_tag" as const,
  }));

  await deps.memory.retainBatch(bankId, items);

  const byNetwork: Record<string, number> = {};
  for (const mem of data.memories) {
    byNetwork[mem.network] = (byNetwork[mem.network] ?? 0) + 1;
  }

  logger.info({ extracted: data.memories.length, byNetwork, bankId }, "memory extraction complete");

  return { extracted: data.memories.length, byNetwork };
}
