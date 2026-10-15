import { match } from "ts-pattern";
import { extractText, isHarnessPrompt } from "../../llm/content.js";
import type { TextBlock } from "../../llm/types.js";
import type { ChatHistoryAttachment, ChatHistoryMessage } from "../store/index.js";
import type { StoredContentBlock, StoredMessage } from "../stored-content.js";

/**
 * Project a conversation's stored messages onto the history a chat surface
 * displays: each turn's prose and its attachments. Image labels and the
 * loop's harness prompts are dropped; an arrival placeholder is an attachment
 * note, apart from the user's words. Turns with neither prose nor attachments
 * (tool roundtrips, the continuation prompt) are dropped.
 */
export function toChatHistory(
  rows: ReadonlyArray<StoredMessage & { id: string }>,
): ChatHistoryMessage[] {
  return rows.flatMap((m) => {
    if (typeof m.content === "string") {
      return m.content.length > 0
        ? [{ id: m.id, role: m.role, text: m.content, attachments: [] }]
        : [];
    }
    const blocks = m.content.filter((b) => !isHarnessPrompt(b));
    const text = extractText(blocks.filter(isProse));
    const attachments = blocks.flatMap(toAttachment);
    return text.length > 0 || attachments.length > 0
      ? [{ id: m.id, role: m.role, text, attachments }]
      : [];
  });
}

function toAttachment(block: StoredContentBlock): ChatHistoryAttachment[] {
  return match(block)
    .with({ type: "image_ref" }, (image): ChatHistoryAttachment[] => [
      { kind: "image", name: image.name ?? null, mediaType: image.original.mediaType },
    ])
    .with({ type: "document_ref" }, (document): ChatHistoryAttachment[] => [
      { kind: "document", name: document.name, mediaType: document.mediaType },
    ])
    .with({ type: "text", harness: "attachment_placeholder" }, (note): ChatHistoryAttachment[] => [
      { kind: "placeholder", text: note.text },
    ])
    .otherwise(() => []);
}

/** Whether `block` is prose of the message: text that isn't an arrival label or placeholder. */
function isProse(block: StoredContentBlock): block is TextBlock {
  return (
    block.type === "text" &&
    block.harness !== "image_label" &&
    block.harness !== "attachment_placeholder"
  );
}
