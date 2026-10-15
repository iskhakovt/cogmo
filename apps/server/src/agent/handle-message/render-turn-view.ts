import type { ContentBlock, Message } from "../../llm/types.js";
import type { AttachmentStore } from "../../transport/attachment-store.js";
import { type FixedCutoff, fixAttachmentCutoff } from "../attachments/attachment-cutoff.js";
import type { AttachmentReader } from "../attachments/attachment-reader.js";
import { renderStoredMessages } from "../attachments/render-stored-content.js";
import type { EpochSnapshot } from "../system-prompt-snapshot.js";
import type { SubstitutedInbound } from "./inbound-batch.js";
import type { TurnTranscript } from "./load-turn-transcript.js";
import { resolveInboundAttachments } from "./resolve-attachments.js";
import type { TurnModel } from "./resolve-turn-model.js";

export interface TurnView {
  /** The loaded history as sent, positionally aligned with `transcript.history`. */
  messages: Message[];
  /** Where the turn's own message sits in `messages`. */
  turnIndex: number;
  /** The cutoff the view renders under, and whether the turn moved it. */
  cutoff: FixedCutoff;
}

/**
 * The turn's history as sent (design/prompt-caching.md → One renderer): the
 * attachment cutoff fixed from memoized values (the refs' sizes, the frozen
 * limits, the epoch's cutoff), then every row rendered under it. A turn row
 * holding refs renders from the row; a JSON-string turn row, which arrival
 * writes for an attachment turn until refs are written, sends its inbound
 * batch's attachments resolved.
 *
 * Bare body, on every invocation: the rendered attachments must stay out of
 * step state.
 */
export async function renderTurnView(
  deps: { attachmentReader: AttachmentReader; attachments: Pick<AttachmentStore, "download"> },
  args: {
    transcript: TurnTranscript;
    turnModel: Pick<TurnModel, "attachmentBudget">;
    snapshot: EpochSnapshot | null;
    substitutedMessages: ReadonlyArray<SubstitutedInbound>;
  },
): Promise<TurnView> {
  const { history, turn } = args.transcript;
  const turnIndex = history.messageIds.lastIndexOf(turn.id);
  const turnRow = history.messages[turnIndex];
  if (turnRow === undefined) {
    throw new Error(`user message ${turn.id} is missing from the turn's history`);
  }
  const resolved =
    typeof turnRow.content === "string"
      ? await resolveInboundAttachments(deps.attachments, args.substitutedMessages)
      : [];
  const resolvedAttachments = resolved.filter((b) => b.type === "image" || b.type === "document");

  const current = args.snapshot?.attachmentCutoff ?? null;
  const cutoff: FixedCutoff =
    args.turnModel.attachmentBudget === null
      ? { kind: "kept", cutoff: current }
      : fixAttachmentCutoff({
          messages: history.messages,
          messageIds: history.messageIds,
          end: turnIndex,
          current,
          budget: args.turnModel.attachmentBudget,
          extra: resolvedLoad(resolvedAttachments),
        });

  const rendered = await renderStoredMessages(
    history.messages,
    history.messageIds,
    deps.attachmentReader,
    cutoff.cutoff,
  );
  return {
    messages:
      resolvedAttachments.length > 0
        ? rendered.with(turnIndex, { role: turnRow.role, content: resolved })
        : rendered,
    turnIndex,
    cutoff,
  };
}

/** What a JSON-string turn row's resolved attachments add to the request. */
function resolvedLoad(blocks: ReadonlyArray<ContentBlock>): { bytes: number; images: number } {
  return blocks.reduce(
    (load, b) =>
      b.type === "image" || b.type === "document"
        ? {
            bytes: load.bytes + b.data.length,
            images: load.images + (b.type === "image" ? 1 : 0),
          }
        : load,
    { bytes: 0, images: 0 },
  );
}
