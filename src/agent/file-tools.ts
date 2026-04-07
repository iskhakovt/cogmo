import { z } from "zod";
import { defineTool } from "./tools.js";

const MAX_READ_LENGTH = 100_000;

export const readFile = defineTool({
  name: "read_file",
  description:
    "Read a file from the workspace. " +
    "Use to review notes, drafts, or any previously saved content.",
  schema: z.object({
    path: z.string().describe("File path (e.g. 'notes/meeting.md')"),
  }),
  handler: async (input, service) => {
    let content = await service.files.read(input.path);
    if (content.length > MAX_READ_LENGTH) {
      content = `${content.slice(0, MAX_READ_LENGTH)}\n\n[Content truncated at ${MAX_READ_LENGTH} characters]`;
    }
    return content;
  },
});

export const writeFile = defineTool({
  name: "write_file",
  description:
    "Write content to a file in the workspace. Creates or overwrites. " +
    "Use proactively to save notes, drafts, summaries, or anything the user wants to keep.",
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

export const listFiles = defineTool({
  name: "list_files",
  description:
    "List files in the workspace, optionally filtered by path prefix. " +
    "Use to see what files exist before reading or to find a specific file.",
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

export const fileTools = [readFile, writeFile, listFiles];
