import { type AttachmentLimits, attachmentBudget } from "../../llm/attachment-limits.js";
import type { Message } from "../../llm/types.js";
import type { StoredMessage } from "../stored-content.js";
import { stripThinkingBefore } from "../system-prompt-snapshot.js";
import { fixAttachmentCutoff } from "./attachment-cutoff.js";
import type { AttachmentReader } from "./attachment-reader.js";
import { renderStoredMessages } from "./render-stored-content.js";

/**
 * A summarization span as the fork sends it (design/context-management.md →
 * Strategy 2 → Images): its rows rendered under the conversation's cutoff,
 * advanced over the span where the summarization route's budget is smaller
 * than the view's. An advance shows the fork placeholders the turn never sent,
 * which the thinking after them isn't bound to, so it strips every thinking
 * block.
 */
export async function renderForkSpan(
  reader: AttachmentReader,
  args: {
    messages: ReadonlyArray<StoredMessage>;
    messageIds: ReadonlyArray<string | null>;
    /** The conversation's cutoff, which the turn's view renders under. */
    cutoff: string | null;
    /** The summarization route's limits; null where the run froze none. */
    limits: AttachmentLimits | null;
    /**
     * The span as the turn's view sent it, which the fork sends unless the
     * cutoff advances; absent outside a turn.
     */
    sent?: ReadonlyArray<Message>;
  },
): Promise<Message[]> {
  const fixed =
    args.limits === null
      ? { cutoff: args.cutoff, advanced: false }
      : fixAttachmentCutoff({
          messages: args.messages,
          messageIds: args.messageIds,
          end: args.messages.length,
          current: args.cutoff,
          budget: attachmentBudget(args.limits),
          extra: { bytes: 0, images: 0 },
        });
  if (!fixed.advanced && args.sent !== undefined) return [...args.sent];
  const rendered = await renderStoredMessages(args.messages, args.messageIds, reader, fixed.cutoff);
  return fixed.advanced ? stripThinkingBefore(rendered, rendered.length) : rendered;
}
