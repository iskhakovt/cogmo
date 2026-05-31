import { z } from "zod";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { defineTool, type ToolSpec } from "./tools.js";

/**
 * Payload returned by the `send_document` tool's text result (JSON-encoded).
 *
 * Two consumers parse this — the orchestrator's batch path
 * (`extractGeneratedDocuments`) and the Telegram stream handle (mid-stream
 * `sendDocument`). Keep this contract in one place.
 */
export interface GeneratedDocumentPayload {
  path: string;
  mediaType: string;
  name: string;
}

export function parseGeneratedDocumentPayload(raw: string): GeneratedDocumentPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.path !== "string" ||
    typeof obj.mediaType !== "string" ||
    typeof obj.name !== "string"
  ) {
    return null;
  }
  return { path: obj.path, mediaType: obj.mediaType, name: obj.name };
}

const TOOL_DESCRIPTION =
  "Send a file attachment to the user. Use when the response is naturally a file " +
  "(long report, generated code, exported data) rather than a chat message. " +
  "Provide the exact filename — its extension picks the icon and download name on the user's end.";

const DEFAULT_MEDIA_TYPE = "application/octet-stream";

/**
 * Lightweight extension → MIME map for the common cases Telegram users
 * actually send/receive. Anything not listed falls back to
 * application/octet-stream — Telegram still delivers it correctly, the
 * downside is just a generic icon.
 */
const EXT_MIME: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  pdf: "application/pdf",
  yaml: "application/yaml",
  yml: "application/yaml",
};

function inferMediaType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return DEFAULT_MEDIA_TYPE;
  return EXT_MIME[ext] ?? DEFAULT_MEDIA_TYPE;
}

export function createDocumentTools(attachments: AttachmentStore): ToolSpec[] {
  return [
    defineTool({
      name: "send_document",
      description: TOOL_DESCRIPTION,
      // Durable: uploads to AttachmentStore. On Inngest retry the cached JSON
      // result (path + mediaType + name) replays, so we don't re-upload.
      durable: true,
      parallelSafe: true,
      schema: z.object({
        filename: z
          .string()
          .min(1)
          .describe("Filename including extension, e.g. 'report.md' or 'data.csv'"),
        content: z.string().min(1).describe("Document body as text"),
        mediaType: z
          .string()
          .optional()
          .describe("Optional MIME type override. Inferred from filename extension if omitted."),
      }),
      handler: async (input) => {
        const mediaType = input.mediaType ?? inferMediaType(input.filename);
        const buffer = Buffer.from(input.content, "utf-8");
        const path = await attachments.upload(buffer, mediaType, "generated");
        return JSON.stringify({ path, mediaType, name: input.filename });
      },
    }),
  ];
}
