import type { Message } from "../llm/types.js";
import { parseGeneratedDocumentPayload } from "./document-tools.js";
import { parseGeneratedImagePayload } from "./image-tools.js";

/**
 * Reference to a generated image stored in AttachmentStore.
 *
 * Emitted by the `generate_image` tool in its text result (JSON).
 * The orchestrator resolves these to Buffers before passing to delivery.
 */
export interface OutboundImageRef {
  path: string;
  mediaType: string;
}

/**
 * Reference to a document attachment uploaded via the `send_document` tool.
 * Resolved to bytes before delivery.
 */
export interface OutboundDocumentRef {
  path: string;
  mediaType: string;
  name: string;
}

/**
 * Walk agent loop output and pull out tool_result payloads scoped to a
 * specific originating tool name.
 *
 * Two-pass: first build `toolUseId → toolName` from `tool_use` blocks across
 * all messages, then walk `tool_result` blocks and only feed `parser` the
 * content of results whose originating tool matches `toolName`.
 *
 * Scoping by originating tool name (not by JSON shape) prevents false
 * positives from other tools that happen to return the same fields. The
 * parser returns null for malformed payloads — caller decides what counts.
 */
function extractToolResultsByName<T>(
  messages: readonly Message[],
  toolName: string,
  parser: (raw: string) => T | null,
): T[] {
  const toolNames = new Map<string, string>();
  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") toolNames.set(block.id, block.name);
    }
  }

  const out: T[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      if (toolNames.get(block.toolUseId) !== toolName) continue;
      if (block.isError) continue;
      const parsed = parser(block.content);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

/**
 * Extract generated image references from agent loop output.
 *
 * Payload parsing goes through `parseGeneratedImagePayload` — the same
 * helper the Telegram stream handle uses for mid-stream delivery, so the
 * batch and streaming paths stay in sync.
 */
export function extractGeneratedImages(messages: readonly Message[]): readonly OutboundImageRef[] {
  return extractToolResultsByName(messages, "generate_image", (raw) => {
    const p = parseGeneratedImagePayload(raw);
    return p ? { path: p.path, mediaType: p.mediaType } : null;
  });
}

/**
 * Extract `send_document` tool results from agent loop output.
 */
export function extractGeneratedDocuments(
  messages: readonly Message[],
): readonly OutboundDocumentRef[] {
  return extractToolResultsByName(messages, "send_document", (raw) => {
    const p = parseGeneratedDocumentPayload(raw);
    return p ? { path: p.path, mediaType: p.mediaType, name: p.name } : null;
  });
}
