import type { JsonValue } from "type-fest";
import type { ContentBlock } from "../llm/types.js";

/**
 * Convert message content to displayable text.
 *
 * TODO: Replace with proper InboundContent schema (Zod).
 * For now, content is JsonValue — strings pass through, objects get stringified.
 */
export function contentToText(content: JsonValue): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * Inbound image reference — S3 path, needs resolution before sending to LLM.
 */
export interface ImageRef {
  type: "image_ref";
  path: string;
  mediaType: string;
}

export type InboundBlock = ContentBlock | ImageRef;

/**
 * Convert inbound message content to blocks.
 *
 * Returns a mix of ContentBlock (ready for LLM) and ImageRef (needs S3 resolution).
 * The orchestrator resolves ImageRefs before passing to the agent loop.
 */
export function contentToBlocks(content: JsonValue): InboundBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (Array.isArray(content)) {
    return content.flatMap((item) => contentToBlocks(item as JsonValue));
  }

  if (content !== null && typeof content === "object") {
    const obj = content as Record<string, unknown>;

    // Image reference with S3 path — emitted by adapters after uploadAttachment
    if (obj.type === "image" && typeof obj.path === "string" && typeof obj.mediaType === "string") {
      return [{ type: "image_ref", path: obj.path as string, mediaType: obj.mediaType as string }];
    }

    // Image with inline data
    if (obj.type === "image" && typeof obj.data === "string" && typeof obj.mediaType === "string") {
      return [
        {
          type: "image",
          source: (obj.source as "base64" | "url") ?? "base64",
          data: obj.data as string,
          mediaType: obj.mediaType as string,
        },
      ];
    }

    if (obj.type === "text" && typeof obj.text === "string") {
      return [{ type: "text", text: obj.text as string }];
    }
  }

  return [{ type: "text", text: JSON.stringify(content) }];
}
