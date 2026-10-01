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
  labelRules,
} from "./extraction-schema.js";

/**
 * Consolidation runs once the active learned rules pass this, matching the
 * limit on a user's instruction rules so `# Rules` stays near 45 rules
 * (design/evolution.md → Explicit Instructions → Tools).
 */
const CONSOLIDATION_THRESHOLD = 20;

export interface ExtractionDeps {
  provider: LlmProvider;
  model: string;
  runInTx: Transactor;
  store: Pick<
    AgentStore,
    | "getCorrections"
    | "getInstructionRules"
    | "hasInstructionRule"
    | "upsertCorrection"
    | "retireLearningRule"
    | "countActiveLearnedRules"
  >;
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
  /** Rules still learning that a contradiction retired; the rest of `contradictions` are only logged. */
  retired: number;
  promoted: number;
  outOfScopeReinforcementsSkipped: number;
  /** Contradictions of a rule still learning on a channel the conversation isn't on: logged, not applied. */
  outOfScopeContradictionsSkipped: number;
  /** Reinforcements naming no listed rule, or one retired or merged since the list was read. */
  unknownRuleReinforcementsSkipped: number;
  consolidationNeeded: boolean;
}

/** Whose rules one extraction reads. */
export interface ExtractionScope {
  profileId: string;
  userId: string;
  /**
   * Whether the conversation's profile sees the user's instruction rules, as
   * its turns do (`admitsFirstParty`). A third-party profile's extraction
   * model is never shown them.
   */
  seesUserRules: boolean;
}

/**
 * Extract behavioral corrections from a conversation transcript.
 *
 * Returns counts of what was found and whether consolidation is needed.
 * Pure function — all I/O goes through deps.
 */
export async function extractCorrections(
  history: ReadonlyArray<Message>,
  scope: ExtractionScope,
  deps: ExtractionDeps,
): Promise<ExtractionResult> {
  const transcript = formatTranscript(history);

  if (transcript.trim().length === 0) {
    logger.debug("empty transcript — skipping extraction");
    return {
      extracted: 0,
      reinforced: 0,
      contradictions: 0,
      retired: 0,
      promoted: 0,
      outOfScopeReinforcementsSkipped: 0,
      outOfScopeContradictionsSkipped: 0,
      unknownRuleReinforcementsSkipped: 0,
      consolidationNeeded: false,
    };
  }

  const { learned, instructions } = await deps.runInTx(async (tx) => ({
    learned: await deps.store.getCorrections(tx, scope.profileId),
    instructions: scope.seesUserRules ? await deps.store.getInstructionRules(tx, scope) : [],
  }));
  // The prompt lists each rule under a short label rather than its id; the
  // model's `matchedExistingRuleId` carries the label back.
  const existingRulesByLabel = labelRules([
    ...learned.map((r) => ({ ...r, setByUser: false })),
    ...instructions.map((r) => ({ ...r, setByUser: true })),
  ]);
  const systemPrompt = buildExtractionPrompt(existingRulesByLabel, deps.activeChannelTypes);

  const { data } = await chatTyped({
    provider: deps.provider,
    model: deps.model,
    system: systemPrompt,
    messages: [{ role: "user", content: transcript }],
    schema: CorrectionExtractionSchema,
    name: "correction-extraction",
    repair: {},
  });

  let extracted = 0;
  let reinforced = 0;
  let contradictions = 0;
  let retired = 0;
  let promoted = 0;
  let outOfScopeReinforcementsSkipped = 0;
  let outOfScopeContradictionsSkipped = 0;
  let unknownRuleReinforcementsSkipped = 0;

  const activeChannelSet = new Set(deps.activeChannelTypes);

  for (const correction of data.corrections) {
    if (correction.action === "contradiction") {
      const contradictedRule = existingRulesByLabel.get(correction.matchedExistingRuleId);
      if (contradictedRule === undefined) {
        logger.warn(
          {
            rule: correction.rule,
            matchedLabel: correction.matchedExistingRuleId,
            reasoning: correction.reasoning,
          },
          "extraction: contradiction names an unknown rule label — skipping",
        );
        continue;
      }
      contradictions++;
      const log = {
        rule: correction.rule,
        matchedLabel: correction.matchedExistingRuleId,
        matchedId: contradictedRule.id,
        reasoning: correction.reasoning,
      };
      // The user retracts a live rule in the turn; one still learning, which
      // `# Rules` doesn't show, is retired here.
      if (contradictedRule.active) {
        logger.info(log, "correction contradicts a live rule — logged, not applied");
        continue;
      }
      if (!isRuleInScope(contradictedRule, activeChannelSet)) {
        outOfScopeContradictionsSkipped++;
        logger.warn(
          {
            ...log,
            channelType: contradictedRule.channelType,
            activeChannels: [...activeChannelSet],
          },
          "extraction: contradiction targets a rule outside the active channel set — skipping",
        );
        continue;
      }
      const retiredNow = await deps.runInTx((tx) =>
        deps.store.retireLearningRule(tx, contradictedRule.id),
      );
      if (retiredNow) {
        retired++;
        logger.info(log, "correction contradicts a rule still learning — retired it");
      } else {
        logger.warn(
          log,
          "extraction: contradicted rule was promoted or retired since it was listed",
        );
      }
      continue;
    }

    const channelType =
      correction.action === "new"
        ? coerceChannelType(correction.channelType, activeChannelSet, correction.rule)
        : null;

    if (correction.action === "new") {
      // The rule this correction would write is global on the profile axis.
      const held = await deps.runInTx((tx) =>
        deps.store.hasInstructionRule(tx, {
          userId: scope.userId,
          text: correction.rule,
          profileId: null,
          channelType,
        }),
      );
      if (held) {
        logger.warn(
          { rule: correction.rule, channelType, reasoning: correction.reasoning },
          "extraction: new correction repeats an instruction rule in its scope — dropped",
        );
        continue;
      }
    }

    let existingRuleId: string | null = null;
    if (correction.action === "reinforce") {
      const matchedRule = existingRulesByLabel.get(correction.matchedExistingRuleId);
      if (matchedRule === undefined) {
        logger.warn(
          {
            rule: correction.rule,
            matchedLabel: correction.matchedExistingRuleId,
            activeChannels: [...activeChannelSet],
          },
          "extraction: reinforce names an unknown rule label — skipping",
        );
        unknownRuleReinforcementsSkipped++;
        continue;
      }
      if (!isRuleInScope(matchedRule, activeChannelSet)) {
        outOfScopeReinforcementsSkipped++;
        logger.warn(
          {
            rule: correction.rule,
            matchedId: matchedRule.id,
            channelType: matchedRule.channelType,
            activeChannels: [...activeChannelSet],
          },
          "extraction: reinforce targets a rule outside the active channel set — skipping",
        );
        continue;
      }
      existingRuleId = matchedRule.id;
    }

    const result = await applyCorrection(
      correction,
      channelType,
      existingRuleId,
      deps.runInTx,
      deps.store,
    );
    if (result === null) {
      logger.warn(
        { rule: correction.rule, matchedId: existingRuleId },
        "extraction: reinforce targets a rule retired or merged since it was listed — skipping",
      );
      unknownRuleReinforcementsSkipped++;
      continue;
    }
    if (correction.action === "new") extracted++;
    if (correction.action === "reinforce") reinforced++;
    if (result.promoted) promoted++;
  }

  const activeCount = await deps.runInTx((tx) =>
    deps.store.countActiveLearnedRules(tx, scope.profileId),
  );
  const consolidationNeeded = activeCount > CONSOLIDATION_THRESHOLD;

  logger.info(
    {
      extracted,
      reinforced,
      contradictions,
      retired,
      promoted,
      outOfScopeReinforcementsSkipped,
      outOfScopeContradictionsSkipped,
      unknownRuleReinforcementsSkipped,
      activeCount,
      consolidationNeeded,
    },
    "correction extraction complete",
  );

  return {
    extracted,
    reinforced,
    contradictions,
    retired,
    promoted,
    outOfScopeReinforcementsSkipped,
    outOfScopeContradictionsSkipped,
    unknownRuleReinforcementsSkipped,
    consolidationNeeded,
  };
}

/**
 * Delegates to the store's upsert; the caller has already gated scope and
 * resolved the model's label to `existingRuleId` (null for a new rule). Null
 * when that rule is no longer unretired.
 */
async function applyCorrection(
  correction: CorrectionItem,
  channelType: string | null,
  existingRuleId: string | null,
  runInTx: Transactor,
  store: Pick<AgentStore, "upsertCorrection">,
): Promise<{ promoted: boolean } | null> {
  return runInTx((tx) =>
    store.upsertCorrection(tx, {
      rule: correction.rule,
      category: correction.category,
      profileId: null, // global — industry standard for personal assistants
      channelType,
      ...(existingRuleId !== null && { existingRuleId }),
    }),
  );
}

/**
 * Reinforcing a rule, or retiring one still learning on a contradiction, is
 * gated on the matched rule's `channelType` matching the conversation's
 * active channel set. The prompt is the steering signal that asks the LLM to
 * emit cross-scope wording matches as `new` with the right `channelType`;
 * this gate is the safety net for when it doesn't. The matched rule is
 * already in `existingRules` (loaded for the prompt), so the validation
 * costs nothing extra at the DB layer. Channel-scoped rules pass only when
 * their `channelType` is in the active set; each call site counts and logs
 * an out-of-scope match with a structured warning shaped like
 * `coerceChannelType`'s so audit grepping stays uniform. A label that names
 * no listed rule is rejected at the call site (the unknown-rule branch).
 */
function isRuleInScope(
  matchedRule: { channelType: string | null },
  activeChannelSet: ReadonlySet<string>,
): boolean {
  // Global rules always pass — the gate catches channel-mismatch, not
  // scope-narrowing of a global into channel-specific.
  return matchedRule.channelType === null || activeChannelSet.has(matchedRule.channelType);
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
