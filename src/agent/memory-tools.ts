import { z } from "zod";
import { defineTool } from "./tools.js";

const tagsMatchSchema = z.enum(["any", "all", "any_strict", "all_strict"]);
const reflectBudgetSchema = z.enum(["low", "mid", "high"]);

export const memoryRecall = defineTool({
  name: "memory_recall",
  description:
    "Search long-term memory for facts, preferences, or context from past conversations. " +
    "Use at the start of conversations and when context would help. " +
    "Prefer this over asking the user something you might already know.",
  schema: z.object({
    query: z.string().describe("Semantic search query — describe what you're looking for"),
  }),
  handler: async (input, service) => {
    const result = await service.memory.recall(input.query);
    if (result.memories.length === 0) {
      return "No relevant memories found.";
    }
    return result.memories.map((m) => `[${m.type}] ${m.content}`).join("\n");
  },
});

export const memoryRetain = defineTool({
  name: "memory_retain",
  description:
    "Store an important fact, preference, or piece of information in long-term memory. " +
    "Use when the user tells you something worth remembering: preferences, decisions, commitments, " +
    "project context. Don't store trivial chat or information already saved in files.",
  schema: z.object({
    content: z.string().describe("The fact or information to remember"),
    context: z.string().optional().describe("Optional context about when/why this was learned"),
  }),
  handler: async (input, service) => {
    await service.memory.retain(input.content, {
      ...(input.context !== undefined && { context: input.context }),
      tags: ["network:world"],
    });
    return "Remembered.";
  },
});

export const memoryReflect = defineTool({
  name: "memory_reflect",
  // Durable: reflect drives Hindsight's own agentic reasoning loop — multiple
  // billable LLM round-trips per call. On Inngest retry the cached synthesized
  // answer replays, avoiding re-running the whole loop.
  durable: true,
  description:
    "Synthesize an answer from long-term memory via an agentic reasoning loop — " +
    "searches memories, follows entity-graph links, and returns a synthesized answer " +
    "(not raw hits). Use for open-ended questions that need multi-hop reasoning " +
    'across many facts (e.g. "summarize what I know about Alice", ' +
    '"what risks should I watch for on project X?"). ' +
    "Heavier than `memory_recall`: runs its own LLM calls, higher latency and cost. " +
    "Prefer `memory_recall` for simple lookups; reach for `memory_reflect` only when " +
    "synthesis across many memories is genuinely needed.",
  schema: z.object({
    query: z.string().describe("The question to answer via synthesis over memories"),
    budget: reflectBudgetSchema
      .default("low")
      .describe(
        "Reasoning budget — 'low' (fast, cheap, default), 'mid', or 'high' " +
          "(deeper multi-hop reasoning at higher cost and latency).",
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe("Optional tag filter to narrow which memories are considered."),
    tagsMatch: tagsMatchSchema
      .optional()
      .describe(
        "How to match tags: 'any' (OR, includes untagged), 'all' (AND, includes untagged), " +
          "'any_strict' (OR, excludes untagged), 'all_strict' (AND, excludes untagged).",
      ),
  }),
  handler: async (input, service) => {
    const result = await service.memory.reflect(input.query, {
      budget: input.budget,
      ...(input.tags !== undefined && { tags: input.tags }),
      ...(input.tagsMatch !== undefined && { tagsMatch: input.tagsMatch }),
    });
    return result.answer;
  },
});

export const memoryTools = [memoryRecall, memoryRetain, memoryReflect];
