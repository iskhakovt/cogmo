import { z } from "zod";
import { defineTool } from "./tools.js";

export const coreMemoryUpdate = defineTool({
  name: "core_memory_update",
  description:
    "Update a core memory block — a structured note that persists across conversations " +
    "and is always visible in your instructions. Use for important, evolving context: " +
    "user profile (name, role, preferences), active projects, recurring topics. " +
    "Blocks are identified by key. Overwrites the entire block content.",
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
