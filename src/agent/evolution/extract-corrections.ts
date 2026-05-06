/**
 * Correction extraction — pure function with injected dependencies.
 *
 * Analyzes a conversation transcript for behavioral corrections,
 * compares against existing rules for dedup, and persists new/reinforced
 * corrections via the store. Graduation logic (observation threshold)
 * lives in the store's upsertCorrection method.
 */

import * as R from "remeda";
import type { LlmProvider } from "../../llm/provider.js";
import { chatTyped } from "../../llm/typed.js";
import type { ContentBlock, Message } from "../../llm/types.js";
import { logger } from "../../logger.js";
import type { AgentStore } from "../store/index.js";
import {
  buildExtractionPrompt,
  CorrectionExtractionSchema,
  type CorrectionItem,
} from "./extraction-schema.js";

const CONSOLIDATION_THRESHOLD = 30;

export interface ExtractionDeps {
  provider: LlmProvider;
  model: string;
  store: Pick<AgentStore, "getCorrections" | "upsertCorrection" | "countActiveRules">;
}

export interface ExtractionResult {
  extracted: number;
  reinforced: number;
  contradictions: number;
  promoted: number;
  consolidationNeeded: boolean;
}

/**
 * Extract behavioral corrections from a conversation transcript.
 *
 * Returns counts of what was found and whether consolidation is needed.
 * Pure function — all I/O goes through deps.
 */
export async function extractCorrections(
  history: ReadonlyArray<Message>,
  profileId: string,
  deps: ExtractionDeps,
): Promise<ExtractionResult> {
  const transcript = formatTranscript(history);

  if (transcript.trim().length === 0) {
    logger.debug("empty transcript — skipping extraction");
    return {
      extracted: 0,
      reinforced: 0,
      contradictions: 0,
      promoted: 0,
      consolidationNeeded: false,
    };
  }

  const existingRules = await deps.store.getCorrections(profileId);
  const systemPrompt = buildExtractionPrompt(existingRules);

  const { data } = await chatTyped({
    provider: deps.provider,
    model: deps.model,
    system: systemPrompt,
    messages: [{ role: "user", content: transcript }],
    schema: CorrectionExtractionSchema,
    name: "correction-extraction",
  });

  let extracted = 0;
  let reinforced = 0;
  let contradictions = 0;
  let promoted = 0;

  for (const correction of data.corrections) {
    if (correction.action === "contradiction") {
      logger.info(
        {
          rule: correction.rule,
          matchedId: correction.matchedExistingRuleId,
          reasoning: correction.reasoning,
        },
        "correction contradicts existing rule — skipped",
      );
      contradictions++;
      continue;
    }

    const result = await applyCorrection(correction, deps.store);
    if (correction.action === "new") extracted++;
    if (correction.action === "reinforce") reinforced++;
    if (result.promoted) promoted++;
  }

  const activeCount = await deps.store.countActiveRules(profileId);
  const consolidationNeeded = activeCount > CONSOLIDATION_THRESHOLD;

  logger.info(
    { extracted, reinforced, contradictions, promoted, activeCount, consolidationNeeded },
    "correction extraction complete",
  );

  return { extracted, reinforced, contradictions, promoted, consolidationNeeded };
}

async function applyCorrection(
  correction: CorrectionItem,
  store: Pick<AgentStore, "upsertCorrection">,
): Promise<{ promoted: boolean }> {
  return store.upsertCorrection({
    rule: correction.rule,
    category: correction.category,
    profileId: null, // global — industry standard for personal assistants
    ...(correction.matchedExistingRuleId != null && {
      existingRuleId: correction.matchedExistingRuleId,
    }),
  });
}

// --- Transcript formatting ---

/**
 * Format a Message[] array into human-readable transcript text.
 *
 * Strips images and thinking blocks (not useful for correction extraction).
 * Preserves tool_use/tool_result as compact notation.
 */
export function formatTranscript(messages: ReadonlyArray<Message>): string {
  return R.pipe(
    messages,
    R.map(formatMessage),
    R.filter((line) => line.length > 0),
  ).join("\n\n");
}

function formatMessage(msg: Message): string {
  if (typeof msg.content === "string") {
    return `${roleLabel(msg.role)}: ${msg.content}`;
  }

  const parts = R.pipe(
    msg.content,
    R.map(formatBlock),
    R.filter((part) => part.length > 0),
  );

  if (parts.length === 0) return "";
  return `${roleLabel(msg.role)}: ${parts.join("\n")}`;
}

function roleLabel(role: "user" | "assistant"): string {
  return role === "user" ? "User" : "Assistant";
}

function formatBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "tool_use":
      return `[Tool: ${block.name}(${JSON.stringify(block.input)})]`;
    case "tool_result":
      return block.isError ? `→ [Error] ${block.content}` : `→ ${block.content}`;
    case "image":
      return "[Image]";
    case "document":
      return `[Document: ${block.name ?? block.mediaType}]`;
    case "thinking":
      return ""; // strip thinking blocks
  }
}
