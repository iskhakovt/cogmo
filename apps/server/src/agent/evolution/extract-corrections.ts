/**
 * Correction extraction — pure function with injected dependencies.
 *
 * Analyzes a chunk of a conversation's new messages for behavioral corrections,
 * compares against existing rules for dedup, and persists new/reinforced
 * corrections via the store. Graduation logic (observation threshold)
 * lives in the store's upsertCorrection method.
 */

import * as R from "remeda";
import type { Transactor } from "../../db/index.js";
import { isHarnessPrompt } from "../../llm/content.js";
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
    | "contradictLearningRule"
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
  /** Rules still learning that a second contradiction, citing another message, retired. */
  retired: number;
  /** Rules still learning whose count a first contradiction reset to 0. */
  reset: number;
  promoted: number;
  outOfScopeReinforcementsSkipped: number;
  /** Contradictions of a rule still learning on a channel the conversation isn't on: logged, not applied. */
  outOfScopeContradictionsSkipped: number;
  /** Reinforcements naming no listed rule, or one retired or merged since the list was read. */
  unknownRuleReinforcementsSkipped: number;
  /** Corrections citing no new message (the earlier conversation, a number out of range, or none): dropped. */
  droppedForContext: number;
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
 * Extract behavioral corrections from a chunk of new messages, read beside
 * the earlier conversation it continues.
 *
 * Returns counts of what was found and whether consolidation is needed.
 * Pure function — all I/O goes through deps.
 */
export async function extractCorrections(
  transcript: ObserverTranscript,
  scope: ExtractionScope,
  deps: ExtractionDeps,
): Promise<ExtractionResult> {
  if (transcript.messages.length === 0) {
    logger.debug("empty transcript — skipping extraction");
    return {
      extracted: 0,
      reinforced: 0,
      contradictions: 0,
      retired: 0,
      reset: 0,
      promoted: 0,
      outOfScopeReinforcementsSkipped: 0,
      outOfScopeContradictionsSkipped: 0,
      unknownRuleReinforcementsSkipped: 0,
      droppedForContext: 0,
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
    messages: [{ role: "user", content: formatObserverTranscript(transcript) }],
    schema: CorrectionExtractionSchema,
    name: "correction-extraction",
    repair: {},
  });

  let extracted = 0;
  let reinforced = 0;
  let contradictions = 0;
  let retired = 0;
  let reset = 0;
  let promoted = 0;
  let outOfScopeReinforcementsSkipped = 0;
  let outOfScopeContradictionsSkipped = 0;
  let unknownRuleReinforcementsSkipped = 0;
  let droppedForContext = 0;

  const activeChannelSet = new Set(deps.activeChannelTypes);

  for (const correction of data.corrections) {
    const messageId = citedMessageId(transcript, correction.sourceMessage);
    if (messageId === undefined) {
      droppedForContext++;
      logger.warn(
        {
          rule: correction.rule,
          sourceMessage: correction.sourceMessage,
          newMessages: transcript.messages.length,
          reasoning: correction.reasoning,
        },
        "extraction: correction cites no new message — dropped",
      );
      continue;
    }
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
      // The user retracts a live rule in the turn. One still learning, which
      // `# Rules` doesn't show, has its count reset by a first contradiction
      // and is retired by a second citing another message: a single
      // mislabelled contradiction costs its evidence, not the rule.
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
      const outcome = await deps.runInTx((tx) =>
        deps.store.contradictLearningRule(tx, {
          id: contradictedRule.id,
          messageId,
        }),
      );
      if (outcome === "retired") {
        retired++;
        logger.info(log, "correction contradicts a rule still learning a second time — retired it");
      } else if (outcome === "reset") {
        reset++;
        logger.info(log, "correction contradicts a rule still learning — reset its count");
      } else {
        logger.info(
          log,
          "extraction: contradiction already applied from this message, or the rule was promoted or retired since it was listed",
        );
      }
      continue;
    }

    const channelType =
      correction.action === "new"
        ? coerceChannelType(correction.channelType, activeChannelSet, correction.rule)
        : null;

    if (correction.action === "new") {
      // Dropped when an instruction this conversation sees covers its scope:
      // a persona's own instruction keeps its text out of a global learned rule.
      const held = await deps.runInTx((tx) =>
        deps.store.hasInstructionRule(tx, {
          userId: scope.userId,
          text: correction.rule,
          profileId: scope.profileId,
          channelType,
        }),
      );
      if (held) {
        logger.warn(
          { rule: correction.rule, channelType, reasoning: correction.reasoning },
          "extraction: new correction repeats an instruction rule covering its scope — dropped",
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
      reset,
      promoted,
      outOfScopeReinforcementsSkipped,
      outOfScopeContradictionsSkipped,
      unknownRuleReinforcementsSkipped,
      droppedForContext,
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
    reset,
    promoted,
    outOfScopeReinforcementsSkipped,
    outOfScopeContradictionsSkipped,
    unknownRuleReinforcementsSkipped,
    droppedForContext,
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
 * Reinforcing a rule, or applying a contradiction to one still learning, is
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
 * What one extraction reads, as transcript lines: a chunk of the
 * conversation's new messages, and the earlier conversation an earlier pass
 * already processed, given only to resolve references.
 */
export interface ObserverTranscript {
  /** The widest compaction summary that ends before the chunk, if any. */
  summary: string | null;
  /** The lines of the last messages before the chunk, oldest first. */
  context: ReadonlyArray<string>;
  /** The chunk's messages with something to show, numbered from 1 in this order. */
  messages: ReadonlyArray<{ id: string; line: string }>;
}

/**
 * The user message an extraction sends: the earlier conversation in
 * `<earlier_conversation>`, when there is one, then the chunk in
 * `<new_messages>`, each message numbered `[n]` for items to cite. The
 * extraction prompts' `TRANSCRIPT_LAYOUT` describes it.
 */
export function formatObserverTranscript(transcript: ObserverTranscript): string {
  const earlier = [
    ...(transcript.summary === null ? [] : [`<summary>\n${transcript.summary}\n</summary>`]),
    ...transcript.context,
  ];
  const numbered = transcript.messages.map((m, i) => `[${i + 1}] ${m.line}`).join("\n\n");
  const fresh = `<new_messages>\n${numbered}\n</new_messages>`;
  if (earlier.length === 0) return fresh;
  return `<earlier_conversation>\n${earlier.join("\n\n")}\n</earlier_conversation>\n\n${fresh}`;
}

/** The id of the new message an item cites by its `[n]`; undefined when it cites none. */
export function citedMessageId(
  transcript: ObserverTranscript,
  sourceMessage: number | null,
): string | undefined {
  if (sourceMessage === null || !Number.isInteger(sourceMessage) || sourceMessage < 1) {
    return undefined;
  }
  return transcript.messages[sourceMessage - 1]?.id;
}

/**
 * Format a Message[] array into human-readable transcript text.
 *
 * Strips images, thinking blocks and the loop's harness prompts (the
 * continuation prompt and the volume-cluster nudge), none of which the user
 * said. Preserves tool_use/tool_result as compact notation.
 */
export function formatTranscript(messages: ReadonlyArray<Message>): string {
  return R.pipe(
    messages,
    R.map(formatMessage),
    R.filter((line) => line.length > 0),
  ).join("\n\n");
}

/** One message as a transcript line; "" when nothing in it is shown. */
export function formatMessage(msg: Message): string {
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
  if (isHarnessPrompt(block)) return "";
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
