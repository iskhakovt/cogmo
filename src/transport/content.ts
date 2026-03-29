import type { JsonValue } from "type-fest";

/**
 * Convert message content to displayable text.
 *
 * TODO: Replace with proper InboundContent schema (Zod).
 * For now, content is JsonValue — strings pass through, objects get stringified.
 */
export function contentToText(content: JsonValue): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}
