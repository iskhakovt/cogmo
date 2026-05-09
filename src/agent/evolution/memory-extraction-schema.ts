/**
 * Zod schemas and prompt for memory extraction.
 *
 * The extraction LLM analyzes a conversation transcript and extracts
 * facts worth remembering, classifying each into a memory network.
 * Results are structured via chatTyped() for reliable parsing.
 */

import { z } from "zod";

// --- Extraction output schema ---

export const MemoryNetworkSchema = z
  .enum(["world", "bank", "opinion", "observation"])
  .describe(
    "Memory network: world (external facts), bank (personal facts/preferences), opinion (agent's assessments), observation (behavioral patterns)",
  );

/**
 * Curated, in-code compartment values. Always recallable / always classifiable;
 * any per-user `custom_compartments` rows extend this set at runtime via
 * `buildCompartmentSchema`. Reserved against custom redefinition.
 */
export const CORE_COMPARTMENTS = [
  "personal",
  "work",
  "health",
  "financial",
  "technical",
  "misc",
] as const;
export type CoreMemoryCompartment = (typeof CORE_COMPARTMENTS)[number];

/**
 * Loose schema for compartment values stored on profile memory scopes and
 * Hindsight tags. The set of valid values is dynamic per user (core ∪ that
 * user's `custom_compartments` rows); validation against the user's actual
 * registry happens at the store boundary on profile create/update — same
 * pattern as `profile_class` (see `src/agent/store/schema.ts:84`). The
 * classifier uses `buildCompartmentSchema(customs)` to lock the LLM to
 * exactly the legal set for the current fire.
 */
export const MemoryCompartmentSchema = z
  .string()
  .min(1)
  .describe(
    "Domain compartment: core values are personal (general life), work (employment/projects), health (medical/fitness), financial (money/accounts), technical (code/systems/infrastructure), misc (everything that fits none of the above). Per-user custom compartments may extend this set.",
  );

/**
 * Build a strict z.enum union of `[...CORE_COMPARTMENTS, ...customNames]` for
 * structured-output classification. Caller passes the user's
 * `custom_compartments` names; an empty array yields just the core enum.
 * Custom names are trusted by this point — the store rejects reserved /
 * over-capacity rows at insert time, so this builder doesn't re-validate.
 *
 * Returns `ZodType<string>` rather than a strict literal-union type because
 * the value array is built at runtime — TS can't infer literal types for a
 * dynamic spread. The runtime guarantee (LLM picks from the set, parse
 * fails otherwise) is what we need; consumers then store as `string`.
 */
export function buildCompartmentSchema(customNames: ReadonlyArray<string>): z.ZodType<string> {
  const values = [...CORE_COMPARTMENTS, ...customNames];
  return z.enum(values);
}

export const MemoryTrustSchema = z
  .enum(["first-party", "any"])
  .describe(
    "Access tier: first-party (only profiles the user controls can access), any (safe for third-party plugins)",
  );

export const ExtractedMemorySchema = z.object({
  fact: z
    .string()
    .trim()
    .min(1)
    .describe("The fact or information to remember — clear, standalone, context-free"),
  network: MemoryNetworkSchema,
  compartment: MemoryCompartmentSchema,
  trust: MemoryTrustSchema,
  context: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional: when or why this was learned, for temporal context"),
});

export const MemoryExtractionSchema = z.object({
  memories: z.array(ExtractedMemorySchema),
});

/**
 * Schema for classifying a single pre-existing fact (e.g. a row in
 * `pending_memories` drained by Observer). The fact text is supplied as
 * input; the LLM returns only the three classification axes.
 */
export const ClassifiedMemorySchema = z.object({
  network: MemoryNetworkSchema,
  compartment: MemoryCompartmentSchema,
  trust: MemoryTrustSchema,
});

export type MemoryNetwork = z.infer<typeof MemoryNetworkSchema>;
export type MemoryCompartment = z.infer<typeof MemoryCompartmentSchema>;
export type MemoryTrust = z.infer<typeof MemoryTrustSchema>;
export type ExtractedMemory = z.infer<typeof ExtractedMemorySchema>;
export type MemoryExtraction = z.infer<typeof MemoryExtractionSchema>;
export type ClassifiedMemory = z.infer<typeof ClassifiedMemorySchema>;

/**
 * Per-fire builders that produce the strict classifier schemas (compartment
 * field locked to `[...CORE, ...customs]`). Use these when calling
 * `chatTyped` so the LLM's structured output is bounded by the user's
 * actual compartment registry. The static `MemoryExtractionSchema` /
 * `ClassifiedMemorySchema` exports stay loose (compartment is `string`)
 * for non-classifier consumers (storage shapes, type imports).
 */
export function buildExtractedMemorySchema(customNames: ReadonlyArray<string>) {
  const compartment = buildCompartmentSchema(customNames);
  return z.object({
    fact: z
      .string()
      .trim()
      .min(1)
      .describe("The fact or information to remember — clear, standalone, context-free"),
    network: MemoryNetworkSchema,
    compartment,
    trust: MemoryTrustSchema,
    context: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional: when or why this was learned, for temporal context"),
  });
}

export function buildMemoryExtractionSchema(customNames: ReadonlyArray<string>) {
  return z.object({ memories: z.array(buildExtractedMemorySchema(customNames)) });
}

export function buildClassifiedMemorySchema(customNames: ReadonlyArray<string>) {
  return z.object({
    network: MemoryNetworkSchema,
    compartment: buildCompartmentSchema(customNames),
    trust: MemoryTrustSchema,
  });
}

// --- Shared taxonomy definitions ---
//
// The three classification axes are described once and templated into
// every prompt that needs them. Tweaks to a definition (e.g. what
// counts as `health` vs `personal`) land in one place — no risk of
// extraction and pending-classification drifting against each other.

const NETWORK_DEFINITIONS = `- **world**: External facts about the world, systems, tools, infrastructure, people, places, events. Things that exist independently of the user's preferences.
  Examples: "homelab IP is 10.0.10.10", "Alice works at Acme Corp", "project deadline is March 15"

- **bank**: Personal facts about the user — preferences, habits, biographical details, relationships, commitments.
  Examples: "prefers tables over prose", "allergic to peanuts", "wife's name is Alice", "runs every morning"

- **opinion**: The agent's learned assessments about what works well or poorly — insights about the user's communication style, effective approaches, tool preferences.
  Examples: "user gets frustrated with verbose explanations", "email extraction v3 works better than v2"

- **observation**: Behavioral patterns the agent has noticed — recurring behaviors, timing patterns, contextual preferences.
  Examples: "usually asks about homelab on weekends", "prefers short responses in the morning"`;

const CORE_COMPARTMENT_DEFINITIONS = `- **personal**: general life — relationships, habits, hobbies, daily preferences, household, family. Default for facts that don't clearly belong elsewhere.
  Examples: "wife's birthday is March 15", "prefers tea over coffee", "lives in Berlin"

- **work**: employment, projects, colleagues, clients, professional commitments — anything tied to the user's job or paid work.
  Examples: "Q3 deadline at Acme is Sept 30", "manager is Alice", "currently leading the migration project"

- **health**: medical, fitness, mental health, dietary restrictions, medications, physiological measurements.
  Examples: "allergic to peanuts", "HbA1c is 6.2", "runs 5km every morning", "takes metformin"

- **financial**: money, accounts, transactions, investments, taxes, billing — anything where leakage to a wrong context is a privacy risk.
  Examples: "Wise account number ends 4711", "files taxes in Germany", "has a Vanguard ISA"

- **technical**: code, infrastructure, tools, systems, APIs, configs — the user's technical stack and personal/work projects' implementation details.
  Examples: "homelab IP is 10.0.10.10", "uses pnpm not npm", "Postgres password rotated last week"

- **misc**: an explicit "none of the above" bucket — facts that genuinely fit no other compartment. Use sparingly; prefer **personal** when the fact is broadly about the user's life. Never use **misc** as a tie-breaker between two real compartments.
  Examples: "owns a 1972 Datsun 240Z", "has competed in Magic: The Gathering tournaments since 2004"`;

const TRUST_DEFINITIONS = `- **first-party**: only profiles the user directly controls can access this. The default for anything the user told us in conversation. Health, financial, and most personal facts should be first-party.
- **any**: safe for third-party plugins or untrusted automation to read. Use sparingly — only for facts that are obviously public or non-sensitive (e.g. "homelab uses Tailscale", "prefers Markdown over RST"). When in doubt, choose first-party.`;

/** A custom compartment row, for prompt-templating purposes. */
export interface CompartmentDefinition {
  name: string;
  description: string;
}

/**
 * Render compartment definitions for the classifier prompt. Core values are
 * always present; per-user customs are appended in the order supplied.
 * Custom descriptions are dropped into the prompt verbatim — operators
 * authoring `/compartments add` give the LLM its instruction sheet.
 *
 * Operators are nudged toward "use core when applicable" by appending a
 * one-line preference rule when customs are present. Without it, an
 * over-eager classifier may pick a custom over `personal` for a borderline
 * fact and silently shift the user's bank's compartment distribution.
 */
export function buildCompartmentDefinitions(customs: ReadonlyArray<CompartmentDefinition>): string {
  if (customs.length === 0) return CORE_COMPARTMENT_DEFINITIONS;
  const customLines = customs.map((c) => `- **${c.name}**: ${c.description}`).join("\n");
  return `${CORE_COMPARTMENT_DEFINITIONS}\n\nCustom compartments (configured for this user):\n${customLines}\n\nWhen a fact fits both a core and a custom compartment, pick the custom — it's there because the user wants those facts isolated.`;
}

// --- Prompts ---

const EXTRACTION_RULES = `## Rules for Extraction

- **Source reliability**: Only extract facts explicitly stated by the user, confirmed by the user, or grounded in tool output. Do not extract unsupported assistant guesses, suggestions, or summaries — the assistant may be wrong.
- **Extract standalone facts**: Each fact should be understandable without the conversation context. "Project X deadline is March 15" not "the deadline is in two weeks".
- **Skip trivial content**: Don't extract greetings, small talk, acknowledgments, or transient discussion.
- **Skip Cogmo platform state**: Don't extract bugs, missing features, "X doesn't work yet", todos, or current limitations of Cogmo (the agent system itself). Cogmo is under active development; today's limitations are stale within weeks.
  Examples of what NOT to extract:
  - "TTS isn't available yet" / "Cogmo can't do voice output"
  - "Recraft image model isn't supported" / "Cogmo only has fal-ai right now"
  - "The /profile compartment picker isn't built" / "Cogmo has no UI for setting memory scope"
  - "Hindsight retainBatch has a bug with multi-item async retains" / "Cogmo's memory writes are slow because of the workaround"
  - "Auto-recall doesn't fire on the first message of a conversation" (any current behavioural quirk)

  Architecture facts that are durable are fine to extract:
  - "Cogmo stores long-term memory in Hindsight"
  - "Cogmo uses the Anthropic API for the main agent loop"
  - "Cogmo's profiles each have their own model and tool set"

  Rule of thumb: if the fact would be wrong after a code change you'd expect to see this quarter, it's state — skip it. If the fact would still be true after several releases, it's architecture — extract it. The user's own technical environment ("user's homelab is offline", "user's NAS uses ZFS") is always durable user-fact and should be extracted regardless — this rule is specifically about Cogmo-the-agent's internals.
- **No conversation references**: Don't mention "the user said" or "in this conversation" — extract the fact itself.
- **Admission criteria**: Only extract facts with future utility, factual confidence, and semantic novelty. Ask: "would knowing this help in a future conversation?"
- **One fact per item**: Don't combine multiple independent facts into one entry.
- **Return empty array if nothing qualifies**: Most short conversations have nothing worth extracting.

Analyze the transcript below and extract facts worth remembering.`;

/**
 * Build the extraction system prompt for an Observer fire. Customs are
 * templated into the compartment section verbatim; pass `[]` for the
 * core-only version.
 */
export function buildMemoryExtractionPrompt(customs: ReadonlyArray<CompartmentDefinition>): string {
  return `You are a memory extraction engine. Your job is to analyze a conversation transcript between a user and an AI assistant, and extract facts worth storing in long-term memory. For each fact, assign three independent classifications: network, compartment, and trust tier.

## Memory Networks (what kind of knowledge)

Classify each fact into exactly one network:

${NETWORK_DEFINITIONS}

## Compartments (what domain)

Classify each fact into exactly one compartment. Compartments isolate domains so a profile scoped to "work" never sees a personal-life fact.

${buildCompartmentDefinitions(customs)}

## Trust Tier (who can access)

Classify each fact into exactly one tier:

${TRUST_DEFINITIONS}

${EXTRACTION_RULES}`;
}

/**
 * Build the classification system prompt for a pending-memory drain. Same
 * shape as `buildMemoryExtractionPrompt` but tuned for single-fact
 * classification (no extraction-rules section).
 */
export function buildPendingClassificationPrompt(
  customs: ReadonlyArray<CompartmentDefinition>,
): string {
  return `You are classifying a single fact for storage in long-term memory. The fact has already been chosen for retention — do not decide whether to keep it. Assign three independent classifications: network, compartment, and trust tier.

## Memory Networks (what kind of knowledge)

${NETWORK_DEFINITIONS}

## Compartments (what domain)

${buildCompartmentDefinitions(customs)}

## Trust Tier (who can access)

${TRUST_DEFINITIONS}

When in doubt on trust, choose first-party. When in doubt on compartment, choose personal.

Output only the JSON classification.`;
}
