import { z } from "zod";
import { formatUserContext } from "./prompt.js";
import { defineTool } from "./tools.js";

export const coreMemoryUpdate = defineTool({
  name: "core_memory_update",
  description:
    "Rewrite a core memory block, shown in your instructions in every conversation. Only " +
    "for who the user is (including who their close family are), their active projects and " +
    "standing preferences and constraints: call it in the same turn the user mentions " +
    "something new or changed about these, even in passing. Replaces the whole block: " +
    "include everything that still holds, as current facts only. A change replaces the old " +
    "value without mentioning it, a finished project is removed, and no relative time words " +
    '("recently", "last month"). Anything else, including a family member\'s details and ' +
    "what used to be true: memory_retain.",
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
    return formatUserContext(await service.coreMemory.get()) ?? "No core memory blocks yet.";
  },
});

export const coreMemoryTools = [coreMemoryUpdate, coreMemoryRead];
