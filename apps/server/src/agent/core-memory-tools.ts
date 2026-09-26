import { z } from "zod";
import { defineTool } from "./tools.js";

export const coreMemoryUpdate = defineTool({
  name: "core_memory_update",
  description:
    "Rewrite a core memory block — a short note visible in your instructions in every " +
    "conversation. For what every conversation needs: who the user is (name, role, location " +
    "and timezone, who their close family are), active projects, standing preferences. " +
    "Call it in the same turn the user mentions a change, even in passing. Not for events, " +
    "one-off details or facts about other people — use memory_retain. Blocks are identified " +
    "by key. Overwrites the whole block: include everything that still holds.",
  // Durable: a DB upsert. The overwrite is idempotent, but exactly-once
  // keeps replays from racing a concurrent same-key update from another
  // turn with stale content.
  durable: true,
  schema: z.object({
    key: z
      .string()
      .describe("Block identifier (e.g. 'user_profile', 'active_projects', 'preferences')"),
    content: z.string().describe("Full block content (replaces previous content)"),
  }),
  handler: async (input, service) => {
    await service.coreMemory.update(input.key, input.content);
    return `Core memory block "${input.key}" updated.`;
  },
});

export const coreMemoryRead = defineTool({
  name: "core_memory_read",
  description:
    "Read all core memory blocks. These are already visible in your system prompt, " +
    "but use this tool if you need to inspect the raw content or check what blocks exist.",
  parallelSafe: true,
  // Reads agent-owned state (blocks written via `core_memory_update`), not
  // external state — but a stuck loop calling this with identical args makes
  // no progress and should trip Class D's gate. Marked false to surface that.
  sideEffectful: false,
  schema: z.object({}),
  handler: async (_input, service) => {
    const blocks = await service.coreMemory.get();
    if (blocks.length === 0) return "No core memory blocks yet.";
    return blocks.map((b) => `## ${b.key}\n${b.content}`).join("\n\n");
  },
});

export const coreMemoryTools = [coreMemoryUpdate, coreMemoryRead];
