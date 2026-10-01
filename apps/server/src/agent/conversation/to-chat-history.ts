import { extractText, isHarnessPrompt } from "../../llm/content.js";
import type { Message } from "../../llm/types.js";
import type { ChatHistoryMessage } from "../store/index.js";

/**
 * Project a conversation's stored messages onto the history a chat surface
 * displays: each turn flattened to its prose. Turns with no displayable
 * prose (tool roundtrips, the loop's continuation prompt) are dropped.
 */
export function toChatHistory(rows: ReadonlyArray<Message & { id: string }>): ChatHistoryMessage[] {
  return rows.flatMap((m) => {
    const text = extractText(
      typeof m.content === "string" ? m.content : m.content.filter((b) => !isHarnessPrompt(b)),
    );
    return text.length > 0 ? [{ id: m.id, role: m.role, text }] : [];
  });
}
