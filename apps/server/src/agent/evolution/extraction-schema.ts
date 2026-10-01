/**
 * Zod schemas and prompt builder for correction extraction.
 *
 * The extraction LLM analyzes a conversation transcript and identifies
 * behavioral corrections — moments where the user redirected the assistant.
 * Results are structured via chatTyped() for reliable parsing.
 */

import * as R from "remeda";
import { z } from "zod";

// --- Extraction output schema ---

const CorrectionBaseSchema = z.object({
  rule: z.string().describe("The behavioral rule, generalized and context-free"),
  category: z
    .enum(["style", "domain", "memory"])
    .describe(
      "Rule category: style (how to respond), domain (what to know), memory (what to remember, track or not store)",
    ),
  reasoning: z
    .string()
    .describe("Why this was identified as a correction — for observability, not stored"),
});

// The two null-valued fields of a `new` correction default to null on
// parse. Where decoding isn't constrained to the schema, a model can omit a
// field whose only meaning is "absent", and repeat the omission on the
// repair retry. `.default()` keeps both fields required in the JSON Schema
// the model is given (a transform would make the schema unrepresentable)
// and leaves the parsed type unchanged.
export const CorrectionItemSchema = z.discriminatedUnion("action", [
  CorrectionBaseSchema.extend({
    action: z.literal("new"),
    matchedExistingRuleId: z.null().default(null),
    channelType: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Channel scope for this rule. Set to a channel type (e.g., 'telegram') only when " +
          "the correction is clearly specific to that channel; otherwise null (applies to all channels). " +
          "Must be one of the channels active in this conversation, or null.",
      ),
  }),
  CorrectionBaseSchema.extend({
    action: z.literal("reinforce"),
    matchedExistingRuleId: z.string(),
  }),
  CorrectionBaseSchema.extend({
    action: z.literal("contradiction"),
    matchedExistingRuleId: z.string(),
  }),
]);

export const CorrectionExtractionSchema = z.object({
  corrections: z.array(CorrectionItemSchema),
});

export type CorrectionItem = z.infer<typeof CorrectionItemSchema>;
export type CorrectionExtraction = z.infer<typeof CorrectionExtractionSchema>;

// --- Rule labels ---

/** The fields `labelRules` orders rules by. */
interface LabelOrderKey {
  id: string;
  rule: string;
  priority: number;
}

/**
 * Give each rule the short label a prompt shows in place of its id (`R1`,
 * `R2`, …), keyed in label order. The prompt renders from this map and the
 * model's answer resolves through it, so the two cannot disagree. A short
 * ordinal is easy for the model to copy exactly, where a slip in a UUID
 * silently drops the match.
 *
 * Labels follow priority, then rule text; the id only breaks an exact tie.
 * Ids and creation order differ between runs, so ordering by them would
 * relabel the same rules and a recorded prompt would stop matching.
 * Comparison is by UTF-16 code unit, which no locale changes.
 */
export function labelRules<T extends LabelOrderKey>(
  rules: ReadonlyArray<T>,
): ReadonlyMap<string, T> {
  const ordered = R.sortBy(
    rules,
    [(r) => r.priority, "asc"],
    [(r) => r.rule, "asc"],
    [(r) => r.id, "asc"],
  );
  return new Map(ordered.map((rule, i) => [`R${i + 1}`, rule]));
}

// --- Extraction prompt ---

/**
 * How both extraction prompts read their user message, which
 * `formatObserverTranscript` lays out: the earlier conversation is context
 * for references, never a source.
 */
export const TRANSCRIPT_LAYOUT = `## Transcript Layout

The transcript may open with an \`<earlier_conversation>\` element: a summary of the conversation and its latest messages, which an earlier pass already analyzed. Use it only to understand the new messages, such as what "that" or "she" refers to, and extract nothing from it. The \`<new_messages>\` element holds the messages to analyze: extract only from those.`;

export function buildExtractionPrompt(
  /** Existing rules keyed by label, as `labelRules` returns them. */
  existingRules: ReadonlyMap<
    string,
    {
      rule: string;
      category: string;
      channelType: string | null;
      /** An instruction rule, which the user set with `rule_set`. */
      setByUser: boolean;
    }
  >,
  activeChannelTypes: ReadonlyArray<string>,
): string {
  const rulesSection =
    existingRules.size > 0
      ? `## Existing Rules

The following rules already exist: learned from previous conversations, or set by the user. Compare each new correction against these to avoid duplicates.

${[...existingRules]
  .map(([label, r], i) => {
    const scope = r.channelType ? `channel:${r.channelType}` : "all channels";
    const setByUser = r.setByUser ? ", set by the user" : "";
    return `${i + 1}. [${label}] (${r.category}, ${scope}${setByUser}) ${r.rule}`;
  })
  .join("\n")}

If a correction is semantically equivalent to an existing rule with the same channel scope, set action to "reinforce" and matchedExistingRuleId to the rule's label (e.g. "R1").
If a correction directly contradicts an existing rule, set action to "contradiction" and matchedExistingRuleId to the contradicted rule's label.
A rule that is similar in wording but applies to a different channel scope (e.g. existing rule applies to all channels but the correction is Telegram-specific) is NOT a match — emit it as "new" with the appropriate channelType.`
      : "No existing rules have been extracted yet. All corrections will be new.";

  const channelsSection =
    activeChannelTypes.length > 0
      ? `## Channel Scope

The conversation reached the assistant via these active channel(s): ${activeChannelTypes
          .map((t) => `\`${t}\``)
          .join(", ")}.

When extracting a "new" correction, set \`channelType\`:
- to one of the active channels above when the correction is clearly tied to that medium (e.g. "don't send long voice notes here" on Telegram, "use markdown headings" on a web UI, "be brief in chat replies"), AND
- to \`null\` (applies to all channels) for general behavioral preferences that aren't medium-specific.

Default to \`null\` when in doubt — channel-specific corrections are the exception, not the norm.`
      : `## Channel Scope

No active channels were resolved for this conversation. Set \`channelType\` to \`null\` for every new correction.`;

  // Only a listed instruction rule can be the one an "already set" names.
  const alreadySetLine = [...existingRules.values()].some((r) => r.setByUser)
    ? `\n- When \`rule_set\` answered that the rule is already set, the user had to say it again: "reinforce" the rule marked "set by the user" that it names.`
    : "";

  return `You are a behavioral correction extractor. Your job is to analyze a conversation transcript between a user and an AI assistant, and identify moments where the user corrected, redirected, or expressed a preference about the assistant's behavior.

## What to Look For

1. **Explicit corrections**: "No, I meant...", "Don't do that", "I told you to..."
2. **Preference statements**: "I prefer...", "Always use...", "Never..."
3. **Frustration signals**: User rephrasing the same request, expressing dissatisfaction
4. **Tool misuse**: User indicating the wrong tool was used, or a tool was used unnecessarily
   - Look at [Tool: ...] blocks — was the tool choice appropriate?
   - Did the user redirect to a different tool or approach?
5. **Implicit corrections**: User doing something differently than the assistant suggested

## Rules for Extraction

- **Forwarded text**: Text inside a \`<forwarded_message>\` element is someone else's words the user forwarded: not a fact about the user or an instruction from them.
- **Generalize**: Extract behavioral rules, not conversation-specific facts. "Prefer concise responses" not "When I asked about weather, you were too verbose".
- **No specific references**: Don't mention specific topics, names, dates, or conversation details in the rule text.
- **One rule per correction**: Each correction becomes one rule. Don't combine multiple corrections.
- **Skip if none found**: Most conversations have no corrections. Return an empty corrections array if nothing qualifies.
- **Categories**:
  - "style": How the assistant should communicate (tone, format, length, approach)
  - "domain": What the assistant should know or do in specific domains
  - "memory": What the assistant remembers, tracks or must not store

## Rules the User Set

The assistant records a standing instruction the user states with the \`rule_set\` tool, and a retraction with \`rule_remove\`. The transcript shows each call as [Tool: rule_set(...)] followed by its result.

- An instruction or retraction that a successful \`rule_set\` or \`rule_remove\` call recorded is handled: extract nothing for it.${alreadySetLine}
- A call that failed ([Error]) recorded nothing: judge the user's words as you would without it.

${channelsSection}

${rulesSection}

${TRANSCRIPT_LAYOUT}

Analyze the new messages below and extract any behavioral corrections.`;
}
