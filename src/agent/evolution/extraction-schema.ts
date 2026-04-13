/**
 * Zod schemas and prompt builder for correction extraction.
 *
 * The extraction LLM analyzes a conversation transcript and identifies
 * behavioral corrections — moments where the user redirected the assistant.
 * Results are structured via chatTyped() for reliable parsing.
 */

import { z } from "zod";

// --- Extraction output schema ---

const CorrectionBaseSchema = z.object({
  rule: z.string().describe("The behavioral rule, generalized and context-free"),
  category: z
    .enum(["style", "domain", "memory"])
    .describe(
      "Rule category: style (how to respond), domain (what to know), memory (what to remember)",
    ),
  reasoning: z
    .string()
    .describe("Why this was identified as a correction — for observability, not stored"),
});

export const CorrectionItemSchema = z.discriminatedUnion("action", [
  CorrectionBaseSchema.extend({
    action: z.literal("new"),
    matchedExistingRuleId: z.null(),
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

// --- Extraction prompt ---

export function buildExtractionPrompt(
  existingRules: ReadonlyArray<{ id: string; rule: string; category: string }>,
): string {
  const rulesSection =
    existingRules.length > 0
      ? `## Existing Rules

The following rules have already been extracted from previous conversations. Compare each new correction against these to avoid duplicates.

${existingRules.map((r, i) => `${i + 1}. [${r.id}] (${r.category}) ${r.rule}`).join("\n")}

If a correction is semantically equivalent to an existing rule, set action to "reinforce" and matchedExistingRuleId to the rule's ID.
If a correction directly contradicts an existing rule, set action to "contradiction" and matchedExistingRuleId to the contradicted rule's ID.`
      : "No existing rules have been extracted yet. All corrections will be new.";

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

- **Generalize**: Extract behavioral rules, not conversation-specific facts. "Prefer concise responses" not "When I asked about weather, you were too verbose".
- **No specific references**: Don't mention specific topics, names, dates, or conversation details in the rule text.
- **One rule per correction**: Each correction becomes one rule. Don't combine multiple corrections.
- **Skip if none found**: Most conversations have no corrections. Return an empty corrections array if nothing qualifies.
- **Categories**:
  - "style": How the assistant should communicate (tone, format, length, approach)
  - "domain": What the assistant should know or do in specific domains
  - "memory": What the assistant should remember or track

${rulesSection}

Analyze the transcript below and extract any behavioral corrections.`;
}
