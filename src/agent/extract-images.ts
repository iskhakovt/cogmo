import type { Message } from "../llm/types.js";
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
 * Extract generated image references from agent loop output.
 *
 * Two-pass: first build `toolUseId → toolName` map from `tool_use` blocks
 * across all messages, then walk `tool_result` blocks and only parse JSON
 * for results whose originating tool was `generate_image`.
 *
 * Scoping by originating tool name prevents false positives from other
 * tools that happen to return `{path, mediaType}`-shaped JSON.
 *
 * Payload parsing goes through `parseGeneratedImagePayload` — the same
 * helper the Telegram stream handle uses for mid-stream delivery, so the
 * batch and streaming paths stay in sync.
 */
export function extractGeneratedImages(messages: readonly Message[]): readonly OutboundImageRef[] {
  const toolNames = new Map<string, string>();
  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") toolNames.set(block.id, block.name);
    }
  }

  const images: OutboundImageRef[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      if (toolNames.get(block.toolUseId) !== "generate_image") continue;
      if (block.isError) continue;
      const payload = parseGeneratedImagePayload(block.content);
      if (payload) images.push({ path: payload.path, mediaType: payload.mediaType });
    }
  }
  return images;
}
