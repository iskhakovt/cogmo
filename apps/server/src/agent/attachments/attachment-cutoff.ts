/**
 * The attachment cutoff (design/prompt-caching.md → Sources and fixes → source
 * (d) → Cutoff): the last row whose attachments render as placeholders. A view
 * whose attachments fit its route's budget keeps its epoch's cutoff;
 * otherwise the cutoff advances, oldest row first, through the rows before
 * the turn's own until the view is within half the budget, and the turn opens
 * an epoch. A pure function of memoized values, so every invocation agrees.
 */

import type { AttachmentBudget } from "../../llm/attachment-limits.js";
import { base64Bytes, isAttachmentRef, type StoredMessage } from "../stored-content.js";
import { isAtOrBefore } from "./render-stored-content.js";

/** What a row's attachments add to a request. */
interface AttachmentLoad {
  bytes: number;
  images: number;
}

/** The base64 bytes and image count of a row's refs. */
function attachmentLoad(message: StoredMessage): AttachmentLoad {
  if (typeof message.content === "string") return { bytes: 0, images: 0 };
  return message.content.filter(isAttachmentRef).reduce(
    (load, ref) => ({
      bytes: load.bytes + base64Bytes(ref),
      images: load.images + (ref.type === "image_ref" ? 1 : 0),
    }),
    { bytes: 0, images: 0 },
  );
}

function within(load: AttachmentLoad, budget: AttachmentBudget, fraction: number): boolean {
  return load.bytes <= budget.bytes * fraction && load.images <= budget.images * fraction;
}

/**
 * The cutoff a view renders under: the epoch's, `kept`, or one moved past it,
 * `advanced`, for which the turn opens an `attachments` epoch.
 */
export type FixedCutoff =
  | { kind: "kept"; cutoff: string | null }
  | { kind: "advanced"; cutoff: string };

/**
 * The cutoff a view renders under. `end` is the first position that can't be
 * cut: the turn's own row, whose attachments the arrival cap bounds, or the
 * end of a summarization span. `extra` is what the view carries that no ref
 * records: a JSON-string turn row's resolved attachments.
 */
export function fixAttachmentCutoff(args: {
  messages: ReadonlyArray<StoredMessage>;
  messageIds: ReadonlyArray<string | null>;
  end: number;
  current: string | null;
  budget: AttachmentBudget;
  extra: AttachmentLoad;
}): FixedCutoff {
  const { messages, messageIds, budget } = args;
  const loads = messages.map((message, i) =>
    isAtOrBefore(messageIds[i] ?? null, args.current)
      ? { bytes: 0, images: 0 }
      : attachmentLoad(message),
  );
  const total = loads.reduce(
    (sum, load) => ({ bytes: sum.bytes + load.bytes, images: sum.images + load.images }),
    args.extra,
  );
  if (within(total, budget, 1)) return { kind: "kept", cutoff: args.current };

  let remaining = total;
  let cutoff = args.current;
  for (let i = 0; i < Math.min(args.end, messages.length); i++) {
    const id = messageIds[i] ?? null;
    const load = loads[i];
    // Only a row with attachments moves the cutoff: one that removes nothing
    // would open an epoch for nothing.
    if (id === null || load === undefined || (load.bytes === 0 && load.images === 0)) continue;
    if (within(remaining, budget, 0.5)) break;
    remaining = { bytes: remaining.bytes - load.bytes, images: remaining.images - load.images };
    cutoff = id;
  }
  return cutoff === null || cutoff === args.current
    ? { kind: "kept", cutoff: args.current }
    : { kind: "advanced", cutoff };
}
