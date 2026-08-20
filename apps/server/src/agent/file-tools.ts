import { z } from "zod";
import { defineTool } from "./tools.js";

export const readFile = defineTool({
  name: "read_file",
  description:
    "Read a file from the workspace. " +
    "Use to review notes, drafts, or any previously saved content. " +
    "Reading a file is also the prerequisite for editing or overwriting it.",
  parallelSafe: true,
  sideEffectful: false,
  // Legitimate exploration of a workspace touches many files.
  invocationBudget: 10,
  schema: z.object({
    path: z.string().describe("File path (e.g. 'notes/meeting.md')"),
  }),
  handler: (input, service) => service.files.read(input.path),
});

export const writeFile = defineTool({
  name: "write_file",
  description:
    "Write content to a file in the workspace. Creates the file when it does not exist, " +
    "otherwise overwrites it. To overwrite, read the file in this conversation first so the " +
    "new content reflects the current state. Prefer `edit_file` for changes that only touch " +
    "part of an existing file — overwriting is for fresh files or full rewrites.",
  // Durable: a workspace mutation. Exactly-once matters less for an
  // idempotent overwrite than for edit_file, but caching keeps the
  // persisted tool_result identical to what the model saw instead of
  // whatever a later boundary's re-execution returned.
  durable: true,
  schema: z.object({
    path: z.string().describe("File path (e.g. 'notes/meeting.md')"),
    content: z.string().describe("Content to write"),
  }),
  handler: async (input, service) => {
    await service.files.write(input.path, input.content);
    const bytes = new TextEncoder().encode(input.content).length;
    return `Written ${bytes} bytes to ${input.path}`;
  },
});

export const editFile = defineTool({
  name: "edit_file",
  description:
    "Edit a file by replacing `old_string` with `new_string`. Read the file in this " +
    "conversation first. By default `old_string` must occur exactly once — extend it with " +
    "surrounding context to disambiguate, or set `replace_all` to replace every occurrence. " +
    "Fails if the file has been modified since you read it.",
  // Durable: a re-executed edit finds `old_string` already replaced and
  // errors, so on any step boundary after the call a non-durable handler
  // would flip the recorded tool_result from success to error.
  durable: true,
  schema: z.object({
    path: z.string().describe("File path (e.g. 'notes/meeting.md')"),
    old_string: z
      .string()
      .min(1)
      .describe("Exact text to find. Must be non-empty and unique unless replace_all."),
    new_string: z.string().describe("Replacement text. May be empty to delete `old_string`."),
    replace_all: z
      .boolean()
      .optional()
      .describe("Replace every occurrence instead of requiring uniqueness."),
  }),
  handler: async (input, service) => {
    await service.files.edit(input.path, input.old_string, input.new_string, {
      replaceAll: input.replace_all ?? false,
    });
    return `Edited ${input.path}`;
  },
});

export const listFiles = defineTool({
  name: "list_files",
  description:
    "List files in the workspace, optionally filtered by path prefix. " +
    "Use to see what files exist before reading or to find a specific file.",
  parallelSafe: true,
  sideEffectful: false,
  // Legitimate codebase exploration touches many prefixes.
  invocationBudget: 10,
  schema: z.object({
    prefix: z
      .string()
      .optional()
      .describe("Path prefix to filter (e.g. 'notes/' to list only notes)"),
  }),
  handler: async (input, service) => {
    const entries = await service.files.list(input.prefix);
    if (entries.length === 0) {
      return input.prefix
        ? `No files found with prefix "${input.prefix}".`
        : "No files in workspace.";
    }
    return entries
      .map((e) => {
        const size = e.size < 1024 ? `${e.size}B` : `${(e.size / 1024).toFixed(1)}KB`;
        return `${e.path} (${size}, ${e.lastModified.toISOString()})`;
      })
      .join("\n");
  },
});

export const fileTools = [readFile, writeFile, editFile, listFiles];
