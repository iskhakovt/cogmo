/**
 * Correction extraction for one turn, in two halves with injected
 * dependencies: `extractTurnCorrections` asks the model for the turn's
 * corrections against the rules the profile sees, and `applyCorrections`
 * writes them inside the caller's transaction, the one that moves the turn's
 * observation row out of `pending` (design/observation.md → Slice 1a).
 * Graduation (the observation threshold) lives in the store's
 * `upsertCorrection`.
 */

import * as R from "remeda";
import { match } from "ts-pattern";
import type { Transaction, Transactor } from "../../db/index.js";
import { isHarnessPrompt } from "../../llm/content.js";
import type { LlmProvider } from "../../llm/provider.js";
import { chatTyped } from "../../llm/typed.js";
import { logger } from "../../logger.js";
import type { AgentStore, ExtractionRule, UpsertCorrectionResult } from "../store/index.js";
import type { StoredContentBlock, StoredMessage } from "../stored-content.js";
import {
  buildExtractionPrompt,
  CorrectionExtractionSchema,
  type CorrectionItem,
  labelRules,
} from "./extraction-schema.js";

/**
 * Consolidation runs once the live learned rules pass this, matching the
 * limit on a user's instruction rules so `# Rules` stays near 45 rules
 * (design/evolution.md → Explicit Instructions → Tools).
 */
const CONSOLIDATION_THRESHOLD = 20;

export interface ExtractionDeps {
  provider: LlmProvider;
  model: string;
  runInTx: Transactor;
  store: Pick<AgentStore, "getCorrections" | "getInstructionRules">;
}

/** The store calls `applyCorrections` makes, all on the caller's transaction. */
export type ApplyCorrectionsStore = Pick<
  AgentStore,
  "hasInstructionRule" | "upsertCorrection" | "contradictLearningRule" | "countLiveLearnedRules"
>;

export interface ExtractionResult {
  extracted: number;
  reinforced: number;
  contradictions: number;
  /** Rules still learning that a second contradiction, from another turn, retired. */
  retired: number;
  /** Rules still learning whose count a first contradiction reset to 0. */
  reset: number;
  promoted: number;
  outOfScopeReinforcementsSkipped: number;
  /** Contradictions of a rule still learning on a channel the conversation isn't on: logged, not applied. */
  outOfScopeContradictionsSkipped: number;
  /** Reinforcements naming no listed rule, or one retired or merged since the list was read. */
  unknownRuleReinforcementsSkipped: number;
  consolidationNeeded: boolean;
}

/** What a fire that applied no correction reports. */
export const NO_CORRECTIONS: Readonly<ExtractionResult> = {
  extracted: 0,
  reinforced: 0,
  contradictions: 0,
  retired: 0,
  reset: 0,
  promoted: 0,
  outOfScopeReinforcementsSkipped: 0,
  outOfScopeContradictionsSkipped: 0,
  unknownRuleReinforcementsSkipped: 0,
  consolidationNeeded: false,
};

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

/** A rule as the extraction prompt lists it, under its label. */
export type LabelledRule = ExtractionRule & { setByUser: boolean };

/** The model's corrections for one turn, and the rules its labels name. */
export interface TurnCorrections {
  items: ReadonlyArray<CorrectionItem>;
  rulesByLabel: ReadonlyMap<string, LabelledRule>;
}

/** One turn rendered for the prompt; `context` is the exchange before it, if any. */
export interface TurnText {
  turn: string;
  context: string | null;
}

/**
 * Ask the model for one turn's corrections. Provider failures throw, for the
 * caller to classify.
 */
export async function extractTurnCorrections(
  text: TurnText,
  scope: ExtractionScope,
  activeChannelTypes: ReadonlyArray<string>,
  deps: ExtractionDeps,
): Promise<TurnCorrections> {
  const { learned, instructions } = await deps.runInTx(async (tx) => ({
    learned: await deps.store.getCorrections(tx, scope.profileId),
    instructions: scope.seesUserRules ? await deps.store.getInstructionRules(tx, scope) : [],
  }));
  // The prompt lists each rule under a short label rather than its id; the
  // model's `matchedExistingRuleId` carries the label back.
  const rulesByLabel = labelRules<LabelledRule>([
    ...learned.map((r) => ({ ...r, setByUser: false })),
    ...instructions.map((r) => ({ ...r, setByUser: true })),
  ]);
  const { data } = await chatTyped({
    provider: deps.provider,
    model: deps.model,
    system: buildExtractionPrompt(rulesByLabel, activeChannelTypes),
    messages: [{ role: "user", content: turnMessage(text) }],
    schema: CorrectionExtractionSchema,
    name: "correction-extraction",
    repair: {},
  });
  return { items: data.corrections, rulesByLabel };
}

function turnMessage(text: TurnText): string {
  const turn = `<turn>\n${text.turn}\n</turn>`;
  return text.context === null
    ? turn
    : `<earlier_conversation>\n${text.context}\n</earlier_conversation>\n\n${turn}`;
}

/**
 * One action per target: a contradiction of a rule wins over a reinforcement
 * of it, a rule is reinforced once, and a new rule is written once per text
 * and channel. A turn so moves a rule at most once.
 */
export function collapseCorrections(
  items: ReadonlyArray<CorrectionItem>,
  rulesByLabel: ReadonlyMap<string, { id: string }>,
): ReadonlyArray<CorrectionItem> {
  const targetOf = (c: CorrectionItem): string | undefined =>
    c.action === "new" ? undefined : rulesByLabel.get(c.matchedExistingRuleId)?.id;
  const contradicted = new Set(
    items.flatMap((c) => {
      const id = c.action === "contradiction" ? targetOf(c) : undefined;
      return id === undefined ? [] : [id];
    }),
  );
  const seen = new Set<string>();
  return items.filter((c) => {
    const target = targetOf(c);
    const key = match(c)
      .with({ action: "new" }, (n) => `new:${n.channelType ?? ""}:${normalizedText(n.rule)}`)
      .with({ action: "reinforce" }, { action: "contradiction" }, (m) =>
        // An unknown label is counted and skipped where it is applied.
        target === undefined ? null : `${m.action}:${target}`,
      )
      .exhaustive();
    if (key === null) return true;
    if (c.action === "reinforce" && target !== undefined && contradicted.has(target)) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizedText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Write one turn's corrections on `tx`: the transaction that moved the turn's
 * observation row to `applied`, so the writes and the move commit together.
 * Returns counts of what was written and whether consolidation is needed.
 */
export async function applyCorrections(
  tx: Transaction,
  corrections: TurnCorrections,
  args: {
    turnObservationId: string;
    scope: ExtractionScope;
    activeChannelTypes: ReadonlyArray<string>;
    store: ApplyCorrectionsStore;
  },
): Promise<ExtractionResult> {
  const { store, scope } = args;
  const { rulesByLabel } = corrections;
  const activeChannelSet = new Set(args.activeChannelTypes);

  let extracted = 0;
  let reinforced = 0;
  let contradictions = 0;
  let retired = 0;
  let reset = 0;
  let promoted = 0;
  let outOfScopeReinforcementsSkipped = 0;
  let outOfScopeContradictionsSkipped = 0;
  let unknownRuleReinforcementsSkipped = 0;

  for (const correction of collapseCorrections(corrections.items, rulesByLabel)) {
    if (correction.action === "contradiction") {
      const contradictedRule = rulesByLabel.get(correction.matchedExistingRuleId);
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
      // and is retired by a second from another turn: a single mislabelled
      // contradiction costs its evidence, not the rule.
      if (contradictedRule.status !== "learning") {
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
      const outcome = await store.contradictLearningRule(tx, {
        id: contradictedRule.id,
        turnObservationId: args.turnObservationId,
      });
      match(outcome)
        .with("retired", () => {
          retired++;
          logger.info(
            log,
            "correction contradicts a rule still learning a second time — retired it",
          );
        })
        .with("reset", () => {
          reset++;
          logger.info(log, "correction contradicts a rule still learning — reset its count");
        })
        .with("unchanged", () => {
          logger.info(
            log,
            "extraction: contradiction already applied from this turn, or the rule was promoted or retired since it was listed",
          );
        })
        .exhaustive();
      continue;
    }

    const channelType =
      correction.action === "new"
        ? coerceChannelType(correction.channelType, activeChannelSet, correction.rule)
        : null;

    if (correction.action === "new") {
      // Dropped when an instruction this conversation sees covers its scope:
      // a persona's own instruction keeps its text out of a global learned rule.
      const held = await store.hasInstructionRule(tx, {
        userId: scope.userId,
        text: correction.rule,
        profileId: scope.profileId,
        channelType,
      });
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
      const matchedRule = rulesByLabel.get(correction.matchedExistingRuleId);
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

    const result = await applyCorrection(tx, correction, channelType, existingRuleId, store);
    const countApplied = () => {
      if (correction.action === "new") extracted++;
      if (correction.action === "reinforce") reinforced++;
    };
    match(result)
      .with({ kind: "stale" }, () => {
        logger.warn(
          { rule: correction.rule, matchedId: existingRuleId },
          "extraction: reinforce targets a rule retired or merged since it was listed — skipping",
        );
        unknownRuleReinforcementsSkipped++;
      })
      .with({ kind: "inserted" }, { kind: "reinforced" }, countApplied)
      .with({ kind: "promoted" }, () => {
        countApplied();
        promoted++;
      })
      .exhaustive();
  }

  const activeCount = await store.countLiveLearnedRules(tx, scope.profileId);
  const consolidationNeeded = activeCount > CONSOLIDATION_THRESHOLD;

  const result: ExtractionResult = {
    extracted,
    reinforced,
    contradictions,
    retired,
    reset,
    promoted,
    outOfScopeReinforcementsSkipped,
    outOfScopeContradictionsSkipped,
    unknownRuleReinforcementsSkipped,
    consolidationNeeded,
  };
  logger.info(
    { ...result, activeCount, turnObservationId: args.turnObservationId },
    "correction extraction complete",
  );
  return result;
}

/** Two turns' counts as one fire's; consolidation follows the later turn's count. */
export function addExtractionResults(a: ExtractionResult, b: ExtractionResult): ExtractionResult {
  return {
    extracted: a.extracted + b.extracted,
    reinforced: a.reinforced + b.reinforced,
    contradictions: a.contradictions + b.contradictions,
    retired: a.retired + b.retired,
    reset: a.reset + b.reset,
    promoted: a.promoted + b.promoted,
    outOfScopeReinforcementsSkipped:
      a.outOfScopeReinforcementsSkipped + b.outOfScopeReinforcementsSkipped,
    outOfScopeContradictionsSkipped:
      a.outOfScopeContradictionsSkipped + b.outOfScopeContradictionsSkipped,
    unknownRuleReinforcementsSkipped:
      a.unknownRuleReinforcementsSkipped + b.unknownRuleReinforcementsSkipped,
    consolidationNeeded: b.consolidationNeeded,
  };
}

/**
 * Delegates to the store's upsert; the caller has already gated scope and
 * resolved the model's label to `existingRuleId` (null for a new rule).
 * `stale` when that rule is no longer live or learning.
 */
async function applyCorrection(
  tx: Transaction,
  correction: CorrectionItem,
  channelType: string | null,
  existingRuleId: string | null,
  store: Pick<AgentStore, "upsertCorrection">,
): Promise<UpsertCorrectionResult> {
  return store.upsertCorrection(tx, {
    rule: correction.rule,
    category: correction.category,
    profileId: null, // global — industry standard for personal assistants
    channelType,
    ...(existingRuleId !== null && { existingRuleId }),
  });
}

/**
 * Reinforcing a rule, or applying a contradiction to one still learning, is
 * gated on the matched rule's `channelType` matching the conversation's
 * active channel set. The prompt is the steering signal that asks the LLM to
 * emit cross-scope wording matches as `new` with the right `channelType`;
 * this gate is the safety net for when it doesn't. The matched rule is
 * already in the labelled rules (loaded for the prompt), so the validation
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
 * Format stored messages into human-readable transcript text.
 *
 * Names each attachment, shows an arrival placeholder as a note, and strips
 * thinking blocks, image labels and the loop's harness prompts (the
 * continuation prompt and the volume-cluster nudge), none of which the user
 * said. Preserves tool_use/tool_result as compact notation.
 */
export function formatTranscript(messages: ReadonlyArray<StoredMessage>): string {
  return R.pipe(
    messages,
    R.map(formatMessage),
    R.filter((line) => line.length > 0),
  ).join("\n\n");
}

function formatMessage(msg: StoredMessage): string {
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

function formatBlock(block: StoredContentBlock): string {
  if (isHarnessPrompt(block)) return "";
  switch (block.type) {
    case "text":
      if (block.harness === "image_label") return "";
      if (block.harness === "attachment_placeholder") return `[Note: ${block.text}]`;
      return block.text;
    case "tool_use":
      return `[Tool: ${block.name}(${JSON.stringify(block.input)})]`;
    case "tool_result":
      return block.isError ? `→ [Error] ${block.content}` : `→ ${block.content}`;
    case "image_ref":
      return `[Image: ${block.name ?? "photo"}]`;
    case "document_ref":
      return `[Document: ${block.name}]`;
    case "thinking":
      return ""; // strip thinking blocks
  }
}
