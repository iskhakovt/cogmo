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

export const ExtractedMemorySchema = z.object({
  fact: z
    .string()
    .trim()
    .min(1)
    .describe("The fact or information to remember — clear, standalone, context-free"),
  network: MemoryNetworkSchema,
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

export type ExtractedMemory = z.infer<typeof ExtractedMemorySchema>;
export type MemoryExtraction = z.infer<typeof MemoryExtractionSchema>;

// --- Extraction prompt ---

export const MEMORY_EXTRACTION_PROMPT = `You are a memory extraction engine. Your job is to analyze a conversation transcript between a user and an AI assistant, and extract facts worth storing in long-term memory.

## Memory Networks

Classify each fact into exactly one network:

- **world**: External facts about the world, systems, tools, infrastructure, people, places, events. Things that exist independently of the user's preferences.
  Examples: "homelab IP is 10.0.10.10", "Alice works at Acme Corp", "project deadline is March 15"

- **bank**: Personal facts about the user — preferences, habits, biographical details, relationships, commitments.
  Examples: "prefers tables over prose", "allergic to peanuts", "wife's name is Alice", "runs every morning"

- **opinion**: The agent's learned assessments about what works well or poorly — insights about the user's communication style, effective approaches, tool preferences.
  Examples: "user gets frustrated with verbose explanations", "email extraction v3 works better than v2"

- **observation**: Behavioral patterns the agent has noticed — recurring behaviors, timing patterns, contextual preferences.
  Examples: "usually asks about homelab on weekends", "prefers short responses in the morning"

## Rules for Extraction

- **Source reliability**: Only extract facts explicitly stated by the user, confirmed by the user, or grounded in tool output. Do not extract unsupported assistant guesses, suggestions, or summaries — the assistant may be wrong.
- **Extract standalone facts**: Each fact should be understandable without the conversation context. "Project X deadline is March 15" not "the deadline is in two weeks".
- **Skip trivial content**: Don't extract greetings, small talk, acknowledgments, or transient discussion.
- **Skip tool-retained facts**: If the assistant explicitly used a memory_retain tool during the conversation, don't re-extract those facts — they're already stored.
- **No conversation references**: Don't mention "the user said" or "in this conversation" — extract the fact itself.
- **Admission criteria**: Only extract facts with future utility, factual confidence, and semantic novelty. Ask: "would knowing this help in a future conversation?"
- **One fact per item**: Don't combine multiple independent facts into one entry.
- **Return empty array if nothing qualifies**: Most short conversations have nothing worth extracting.

Analyze the transcript below and extract facts worth remembering.`;
