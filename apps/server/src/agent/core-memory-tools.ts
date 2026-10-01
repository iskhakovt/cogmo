import { ok } from "neverthrow";
import { match } from "ts-pattern";
import { z } from "zod";
import { type CoreMemoryScope, DOCUMENTED_BLOCK_KEYS } from "./core-memory/scope.js";
import type { CoreMemoryWrite } from "./core-memory/write-core-memory-block.js";
import { formatUserContext } from "./prompt.js";
import { defineTool, reject, type ToolSpec } from "./tools.js";

export const coreMemoryUpdate = defineTool({
  name: "core_memory_update",
  description:
    "Rewrite a core memory block, shown in your instructions in every conversation. Only " +
    "for who the user is (including who their close family are), their active projects and " +
    "standing preferences and constraints: call it in the same turn the user mentions " +
    "something new or changed about these, even in passing. `identity` holds their name " +
    "and what to call them, home, timezone and the languages they speak, as true in every " +
    "persona; a name or form of address for one persona goes in that persona's other blocks, " +
    "as do role, family, projects and preferences. When you write `identity`, remove from " +
    "other blocks any line it now holds. Replaces the whole block: " +
    "include everything that still holds, as current facts only. A change replaces the old " +
    "value without mentioning it, a finished project is removed, and no relative time words " +
    '("recently", "last month"). Anything else, including a family member\'s details and ' +
    "what used to be true: memory_retain.",
  // Durable: a DB write (an upsert, or deleting a restricted class's override).
  // The overwrite is idempotent, but exactly-once keeps replays from racing a
  // concurrent same-key update from another turn with stale content.
  durable: true,
  schema: z.object({
    key: z
      .string()
      .describe(`Block identifier (e.g. ${DOCUMENTED_BLOCK_KEYS.map((k) => `'${k}'`).join(", ")})`),
    content: z.string().describe("Full block content (replaces previous content)"),
  }),
  handler: async (input, service) => {
    const written = await service.coreMemory.update(input.key, input.content);
    return written
      .map((w) => writtenText(input.key, w))
      .orElse(() => reject("Core memory isn't available in this profile."));
  },
});

/** The tool result for a write; for an override, it names the lines left out as shared. */
function writtenText(key: string, written: CoreMemoryWrite): string {
  const onlyHere = "Tell the user it is saved only here.";
  return match(written)
    .with(
      { kind: "override-matches-shared" },
      () =>
        "Nothing saved for this persona: no line differs from the shared identity block, " +
        "so this persona follows it.",
    )
    .with({ kind: "override" }, ({ leftOut }) =>
      leftOut.length === 0
        ? `Saved "${key}" for this persona only; other personas keep the shared block. ${onlyHere}`
        : `Saved "${key}" for this persona only, keeping the lines that differ from the shared ` +
          `block (left out as shared: ${leftOut.map((l) => JSON.stringify(l)).join(", ")}). ` +
          onlyHere,
    )
    .otherwise(() => `Core memory block "${key}" updated.`);
}

export const coreMemoryRead = defineTool({
  name: "core_memory_read",
  description:
    "Read all core memory blocks. These are already visible in your system prompt, " +
    "but use this tool if you need to inspect the raw content or check what blocks exist.",
  // Durable: re-executed on a later step boundary after a same-turn
  // `core_memory_update`, a non-durable handler would record blocks the model
  // never saw.
  durable: true,
  parallelSafe: true,
  // Reads agent-owned state (blocks written via `core_memory_update`), not
  // external state — but a stuck loop calling this with identical args makes
  // no progress and should trip Class D's gate. Marked false to surface that.
  sideEffectful: false,
  schema: z.object({}),
  handler: async (_input, service) => {
    return ok(formatUserContext(await service.coreMemory.get()) ?? "No core memory blocks yet.");
  },
});

export const coreMemoryTools = [coreMemoryUpdate, coreMemoryRead];

const CORE_MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set(coreMemoryTools.map((t) => t.name));

/** The built-ins a turn offers: without the core-memory tools when its scope has no core memory. */
export function offeredBuiltIns(
  scope: CoreMemoryScope,
  builtIns: ReadonlyArray<ToolSpec>,
): ReadonlyArray<ToolSpec> {
  return scope.kind === "none"
    ? builtIns.filter((t) => !CORE_MEMORY_TOOL_NAMES.has(t.name))
    : builtIns;
}
