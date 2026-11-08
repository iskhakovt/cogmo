import type { Logger } from "pino";
import * as R from "remeda";
import { match } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import type { Durable } from "../../inngest/durable.js";
import type { TransportStore } from "../../transport/store/index.js";
import type { AttachmentRejection } from "../../transport/store/schema.js";
import { llmIterStepId } from "../loop.js";
import type { TranscriptStore } from "../store/index.js";
import { refOriginals } from "../stored-content.js";
import type { ProviderRefusal } from "../turn-step-runner.js";
import { countTokensStepId } from "./compact-turn.js";

export interface MarkRejectedAttachmentsDeps {
  runInTx: Transactor;
  agentStore: Pick<TranscriptStore, "getLastAssistantMessage" | "listUserRowsAfter">;
  transportStore: Pick<TransportStore, "rejectAttachmentOriginals">;
}

/**
 * Whether a refused request was the first of its kind to carry the turn's
 * rows: the first count, or the first iteration. A later count or iteration
 * carried them after the provider accepted them once.
 */
function isFirstRequest(step: string): boolean {
  return step === countTokensStepId(1) || step === llmIterStepId(1);
}

/**
 * What a refusal says about the turn's attachments: a 413 is a request over
 * the size cap, which attachments reach, and a 400 a request the provider
 * can't read. Null when it marks nothing: another status, a request after
 * one the provider accepted, or no refusal from a chat turn's step.
 */
function rejectionOf(
  refusal: ProviderRefusal | null,
): { rejection: AttachmentRejection; cursor: string } | null {
  if (refusal === null || !isFirstRequest(refusal.step)) return null;
  const { cursor } = refusal;
  return match(refusal.status)
    .with(400, () => ({ rejection: "bad_request" as const, cursor }))
    .with(413, () => ({ rejection: "too_large" as const, cursor }))
    .otherwise(() => null);
}

/**
 * A turn whose first count or iteration the provider refused with a 400 or
 * 413 marks the originals its rows carried `rejected`
 * (design/transport/attachments.md → Rejected attachments), so the next turn
 * loads and re-batches them as the rejection placeholder. Its rows are the
 * user rows after the conversation's last reply up to its cursor: its own and
 * the failed batches it re-sent. An original a later turn's row re-sent is
 * left to that turn: its reply shows the provider takes it, and its own
 * refusal marks it.
 *
 * Caught around the step: only a permanently failed one reaches the catch,
 * and degrading to a log is the designed channel, since the next turn sends
 * the attachments again and its own failure marks them.
 *
 * Step: `mark-rejected-attachments`, planned only on such a refusal, which
 * the failure event fixes.
 */
export async function markRejectedAttachments(
  step: Durable,
  deps: MarkRejectedAttachmentsDeps,
  args: { conversationId: string; refusal: ProviderRefusal | null; turnLogger: Logger },
): Promise<void> {
  const { conversationId, turnLogger } = args;
  const refused = rejectionOf(args.refusal);
  if (refused === null) return;
  const { rejection, cursor } = refused;
  try {
    await step.run("mark-rejected-attachments", async () => {
      const marked = await deps.runInTx(async (tx) => {
        const lastReply = await deps.agentStore.getLastAssistantMessage(tx, conversationId);
        const rows = await deps.agentStore.listUserRowsAfter(tx, {
          conversationId,
          afterMessageId: lastReply?.id ?? null,
        });
        // UUIDv7 text compares in the order the inbound ids were minted.
        const [sent, later] = R.partition(rows, (row) => row.cursor <= cursor);
        const resent = new Set(later.flatMap(({ content }) => refOriginals(content)));
        const originals = sent
          .flatMap(({ content }) => refOriginals(content))
          .filter((path) => !resent.has(path));
        return deps.transportStore.rejectAttachmentOriginals(tx, originals, rejection);
      });
      if (marked > 0) {
        turnLogger.info({ rejection, marked }, "the provider refused the turn's attachments");
      }
      return marked;
    });
  } catch (err) {
    turnLogger.error({ err }, "could not mark the refused turn's attachments");
  }
}
