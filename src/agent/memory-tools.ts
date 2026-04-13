import { z } from "zod";
import { defineTool } from "./tools.js";

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

export const memoryTools = [memoryRecall, memoryRetain];
