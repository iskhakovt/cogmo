/**
 * Client-side encryption wrapper around `AttachmentStore`.
 *
 * Wraps `upload` with AES-256-GCM so newly-stored attachments are
 * ciphertext. The byte-level envelope format and primitives live in
 * `src/secrets/blob-envelope.ts` and are shared with the encrypted
 * variant of `Service.files` — both use the same wire format and HKDF
 * purpose string so a single master key covers everything in the
 * bucket.
 *
 * Reads dispatch on the magic prefix — encrypted blobs decrypt
 * strictly, anything else returns raw bytes. Flipping the flag on a
 * populated bucket is a no-op for old objects: pre-flag plaintext
 * stays readable, new uploads are ciphertext, churn converges the
 * bucket over time. No flush, no sweep script.
 *
 * On upload the wrapper pins the inner store's media type to
 * `application/octet-stream` regardless of the caller's value. That
 * neutralizes two metadata leaks the storage provider would otherwise
 * see — the `Content-Type` header on the S3 object (would have been
 * `image/jpeg` etc., advertising the original file type even though
 * the body is opaque) and the file extension in the path (the
 * `mediaTypeToExt` helper resolves `application/octet-stream` to
 * `.bin`). Matches `rclone crypt`'s convention of `.bin` extensions on
 * the underlying remote when name-encryption is off.
 *
 * Consumers that need the original media type get it from the
 * persisted message metadata (`messages.content`,
 * `inbound_messages.content`), never from the bucket — so this
 * neutralization is invisible above the `AttachmentStore` boundary.
 *
 * The transparent fallback is safe at this threat model —
 * confidentiality of *new* uploads against the storage provider, not
 * integrity of all reads against an attacker who already controls the
 * bucket. We don't end-to-end-authenticate attachments today (no
 * DB-side checksums), so accepting an unauthenticated plaintext object
 * on read doesn't weaken any property the encrypted-write path was
 * protecting.
 */

import { decryptBuffer, encryptBuffer, isEncrypted } from "../secrets/blob-envelope.js";
import type { AttachmentStore } from "./attachment-store.js";

/**
 * Wrap an `AttachmentStore` so bytes are encrypted before reaching the
 * underlying storage and decrypted on read. The wrapper preserves the
 * `AttachmentStore` interface — callers above the boundary are unaware.
 */
export function wrapAttachmentStoreWithEncryption(
  inner: AttachmentStore,
  key: Uint8Array,
): AttachmentStore {
  return {
    async upload(data: Buffer, _mediaType: string, prefix?: string): Promise<string> {
      const encrypted = encryptBuffer(data, key);
      return inner.upload(encrypted, "application/octet-stream", prefix);
    },

    async download(path: string): Promise<Buffer> {
      const blob = await inner.download(path);
      return isEncrypted(blob) ? decryptBuffer(blob, key) : blob;
    },
  };
}
