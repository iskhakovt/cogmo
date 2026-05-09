/**
 * Correction extraction — pure function with injected dependencies.
 *
 * Analyzes a conversation transcript for behavioral corrections,
 * compares against existing rules for dedup, and persists new/reinforced
 * corrections via the store. Graduation logic (observation threshold)
 * lives in the store's upsertCorrection method.
 */

import * as R from "remeda";
import type { Transactor } from "../../db/index.js";
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
  runInTx: Transactor;
  store: Pick<AgentStore, "getCorrections" | "upsertCorrection" | "countActiveRules">;
  /**
   * Distinct channel types active for the conversation when this Observer
   * fired. Threaded into the extraction prompt and used to validate the
   * LLM's `channelType` choice — anything outside the active set is
   * coerced to null (global) with a warning.
   */
  activeChannelTypes: ReadonlyArray<string>;
}

export interface ExtractionResult {
  extracted: number;
  reinforced: number;
  contradictions: number;
  promoted: number;
  crossScopeReinforcementsSkipped: number;
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
      crossScopeReinforcementsSkipped: 0,
      consolidationNeeded: false,
    };
  }

  const existingRules = await deps.runInTx((tx) => deps.store.getCorrections(tx, profileId));
  const systemPrompt = buildExtractionPrompt(existingRules, deps.activeChannelTypes);

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
  let crossScopeReinforcementsSkipped = 0;

  const activeChannelSet = new Set(deps.activeChannelTypes);

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

    if (correction.action === "reinforce") {
      const matchedRule = existingRules.find((r) => r.id === correction.matchedExistingRuleId);
      if (!isReinforcementInScope(matchedRule, correction, activeChannelSet)) {
        crossScopeReinforcementsSkipped++;
        continue;
      }
    }

    const channelType =
      correction.action === "new"
        ? coerceChannelType(correction.channelType, activeChannelSet, correction.rule)
        : null;
    const result = await applyCorrection(correction, channelType, deps.runInTx, deps.store);
    if (correction.action === "new") extracted++;
    if (correction.action === "reinforce") reinforced++;
    if (result.promoted) promoted++;
  }

  // `countActiveRules` counts both axes (channel-scoped + global), but
  // `consolidateRules` only merges global rows. A flood of
  // channel-scoped rules can therefore trip the threshold even though
  // there's nothing to merge — `consolidateRules` short-circuits at
  // its `< 2` global-rules check, so the cost is one redundant read
  // per Observer fire. Left as-is until the steering_rules count
  // crosses ~30 and that read becomes worth saving.
  const activeCount = await deps.runInTx((tx) => deps.store.countActiveRules(tx, profileId));
  const consolidationNeeded = activeCount > CONSOLIDATION_THRESHOLD;

  logger.info(
    {
      extracted,
      reinforced,
      contradictions,
      promoted,
      crossScopeReinforcementsSkipped,
      activeCount,
      consolidationNeeded,
    },
    "correction extraction complete",
  );

  return {
    extracted,
    reinforced,
    contradictions,
    promoted,
    crossScopeReinforcementsSkipped,
    consolidationNeeded,
  };
}

/**
 * Reinforcement is gated on the matched rule's `channelType` matching
 * the conversation's active channel set — `isReinforcementInScope`
 * runs before this call and skips out-of-scope reinforces from the
 * extraction loop. The prompt is the steering signal that asks the
 * LLM to emit cross-scope wording matches as `new` with the right
 * `channelType`; this gate is the safety net for when it doesn't. The
 * matched rule is already in `existingRules` (loaded for the prompt),
 * so the validation costs nothing extra at the DB layer. Global rules
 * (`channelType === null`) always pass — they apply everywhere by
 * definition. A hallucinated `matchedExistingRuleId` that names no
 * loaded rule also skips, which keeps the LLM from fabricating
 * reinforcement for a row we can't even verify.
 */
async function applyCorrection(
  correction: CorrectionItem,
  channelType: string | null,
  runInTx: Transactor,
  store: Pick<AgentStore, "upsertCorrection">,
): Promise<{ promoted: boolean }> {
  return runInTx((tx) =>
    store.upsertCorrection(tx, {
      rule: correction.rule,
      category: correction.category,
      profileId: null, // global — industry standard for personal assistants
      channelType,
      ...(correction.matchedExistingRuleId != null && {
        existingRuleId: correction.matchedExistingRuleId,
      }),
    }),
  );
}

/**
 * Validate that the LLM's `reinforce` action targets a rule whose scope
 * actually applies to this conversation. Global rules always pass.
 * Channel-scoped rules pass only when their `channelType` is in the
 * active set. A missing matched rule (hallucinated id) and an
 * out-of-scope channel match both fail — both cases are logged with
 * the same shape as `coerceChannelType`'s warning so audit grepping
 * stays uniform.
 */
function isReinforcementInScope(
  matchedRule: { id: string; channelType: string | null } | undefined,
  correction: { rule: string; matchedExistingRuleId: string | null },
  activeChannelSet: ReadonlySet<string>,
): boolean {
  if (matchedRule === undefined) {
    logger.warn(
      {
        rule: correction.rule,
        matchedId: correction.matchedExistingRuleId,
        activeChannels: [...activeChannelSet],
      },
      "extraction: reinforce names an unknown rule id — skipping",
    );
    return false;
  }
  if (matchedRule.channelType === null) return true;
  if (activeChannelSet.has(matchedRule.channelType)) return true;
  logger.warn(
    {
      rule: correction.rule,
      matchedId: matchedRule.id,
      channelType: matchedRule.channelType,
      activeChannels: [...activeChannelSet],
    },
    "extraction: reinforce targets a rule outside the active channel set — skipping",
  );
  return false;
}

/**
 * Validate the LLM's `channelType` choice against the active channel set.
 * The prompt constrains the LLM to active channels, but a hallucinated
 * value would silently land a rule under a channel that never matches at
 * lookup time — so anything outside the active set falls back to null
 * (global) with a warning, and the rule still applies.
 */
function coerceChannelType(
  raw: string | null,
  activeChannelSet: ReadonlySet<string>,
  rule: string,
): string | null {
  if (raw === null) return null;
  if (activeChannelSet.has(raw)) return raw;
  logger.warn(
    { rule, channelType: raw, activeChannels: [...activeChannelSet] },
    "extraction: LLM emitted channelType not in active channel set — falling back to global",
  );
  return null;
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
