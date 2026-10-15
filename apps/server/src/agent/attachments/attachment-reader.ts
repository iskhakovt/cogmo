import { LRUCache } from "lru-cache";
import { ok, type Result } from "neverthrow";
import { logger } from "../../logger.js";
import { attachmentPlaceholders } from "../../metrics.js";
import type { AttachmentStore, AttachmentUnreadable } from "../../transport/attachment-store.js";

/** Reads a stored attachment as the base64 a request carries. */
export interface AttachmentReader {
  /**
   * The object at `path` as base64, or why it can never be read. A transient
   * failure throws, so a retried invocation reads it and every replay renders
   * the same request.
   */
  readBase64(path: string): Promise<Result<string, AttachmentUnreadable>>;
}

/** Unreadable paths remembered per process, so each is counted once. */
const UNREADABLE_PATHS = 1024;

/**
 * An {@link AttachmentReader} over `store` with an in-process memo keyed by
 * path. Objects are write-once, so a hit is always current. The memo holds at
 * most `capBytes` of base64; at the largest attachment budget
 * (`LARGEST_ATTACHMENT_BUDGET_BYTES`), a view within any route's budget reads
 * each attachment once per process.
 */
export function createAttachmentReader(
  store: Pick<AttachmentStore, "read">,
  capBytes: number,
): AttachmentReader {
  const memo = new LRUCache<string, string>({
    maxSize: capBytes,
    sizeCalculation: (base64) => Math.max(1, base64.length),
  });
  const unreadable = new LRUCache<string, AttachmentUnreadable>({ max: UNREADABLE_PATHS });
  return {
    async readBase64(path) {
      const known = memo.get(path);
      if (known !== undefined) return ok(known);
      const read = await store.read(path);
      return read
        .map((bytes) => {
          const base64 = bytes.toString("base64");
          // An object over the cap is still served; it just isn't kept.
          if (base64.length <= capBytes) memo.set(path, base64);
          return base64;
        })
        .mapErr((reason) => {
          if (!unreadable.has(path)) {
            unreadable.set(path, reason);
            attachmentPlaceholders.add(1, { reason: "unreadable" });
            logger.warn(
              { path, reason: reason.kind },
              "attachment unreadable; sent as a placeholder",
            );
          }
          return reason;
        });
    },
  };
}
