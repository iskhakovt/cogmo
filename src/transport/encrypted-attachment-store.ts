/**
 * Client-side encryption wrapper around `AttachmentStore`.
 *
 * Wraps `upload` with AES-256-GCM so newly-stored objects are
 * ciphertext. The key is derived from `COGMO_MASTER_KEY` via HKDF
 * (purpose `cogmo/s3-attachments/v1`), mirroring the secrets-at-rest
 * pattern.
 *
 * Object body layout (single self-contained blob):
 *
 *   [magic 4B: 0xC0 0x6C 0x6D 0x6F] [version 2B BE] [nonce 12B] [ciphertext + GCM tag]
 *
 * The 4-byte magic — `0xC0` (an invalid UTF-8 lead byte, never a valid
 * first byte of UTF-8 text) followed by `lmo` — distinguishes encrypted
 * blobs from objects uploaded before the flag was flipped. `download`
 * returns the raw bytes when the magic prefix is missing, so turning the
 * flag on a populated bucket is a no-op for reads: pre-flag plaintext
 * stays readable, new uploads are encrypted, the bucket converges over
 * time. No flush, no sweep script. Collision probability for arbitrary
 * plaintext is 1 in 2^32; for the file formats this app actually handles
 * (JPEG / PNG / GIF / WebP / PDF / OGG / UTF-8 text) it's zero — none
 * starts with `0xC0`.
 *
 * The 2-byte big-endian version field lets future format changes roll
 * forward without a re-encryption migration: `decryptBuffer` fans out on
 * the version and picks the matching cipher / nonce / tag layout. v1 is
 * the only version today.
 *
 * The transparent fallback is safe at this threat model — confidentiality
 * of *new* uploads against the storage provider, not integrity of all
 * reads against an attacker who already controls the bucket. We don't
 * end-to-end-authenticate attachments today (no DB-side checksums), so
 * accepting an unauthenticated plaintext object on read doesn't weaken
 * any property the encrypted-write path was protecting.
 *
 * See `design/infrastructure.md` → Secrets and the `S3_CLIENT_ENCRYPT`
 * env-var doc for the threat model and trade-offs.
 */

import { decryptBytes, encryptBytes } from "../secrets/encryption.js";
import type { AttachmentStore } from "./attachment-store.js";

const MAGIC = Buffer.from([0xc0, 0x6c, 0x6d, 0x6f]);
const MAGIC_LENGTH = MAGIC.length;
const VERSION_LENGTH = 2;
const NONCE_LENGTH = 12;
const HEADER_LENGTH = MAGIC_LENGTH + VERSION_LENGTH + NONCE_LENGTH;

const VERSION_V1 = 1;

/**
 * Wrap an `AttachmentStore` so bytes are encrypted before reaching the
 * underlying storage and decrypted on read. The wrapper preserves the
 * `AttachmentStore` interface — callers above the boundary are unaware.
 *
 * On upload the wrapper pins the inner store's media type to
 * `application/octet-stream` regardless of the caller's value. That
 * neutralizes two metadata leaks the storage provider would otherwise
 * see: the `Content-Type` header on the S3 object (would have been
 * `image/jpeg` etc., advertising the original file type even though
 * the body is opaque) and the file extension in the path (the
 * `mediaTypeToExt` helper resolves `application/octet-stream` to
 * `.bin`). Matches `rclone crypt`'s convention of `.bin` extensions on
 * the underlying remote when name-encryption is off — same rationale,
 * "prevents the cloud provider attempting to interpret file content."
 *
 * Consumers that need the original media type get it from the
 * persisted message metadata (`messages.content`,
 * `inbound_messages.content`), never from the bucket — so this
 * neutralization is invisible above the `AttachmentStore` boundary.
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

/**
 * Whether `blob` carries the Cogmo-encrypted-attachment magic prefix.
 * Magic-only — does not validate the version, nonce, or ciphertext.
 * Version dispatch is `decryptBuffer`'s job.
 */
export function isEncrypted(blob: Buffer): boolean {
  return blob.length >= MAGIC_LENGTH && blob.subarray(0, MAGIC_LENGTH).equals(MAGIC);
}

/**
 * Format a v1 encrypted attachment blob:
 *   [magic 4B] [version 2B BE] [nonce 12B] [ciphertext + GCM tag]
 * Exported for tests; production callers use the wrapper.
 */
export function encryptBuffer(plaintext: Buffer, key: Uint8Array): Buffer {
  const { ciphertext, nonce } = encryptBytes(key, new Uint8Array(plaintext));
  const out = Buffer.allocUnsafe(HEADER_LENGTH + ciphertext.length);
  MAGIC.copy(out, 0);
  out.writeUInt16BE(VERSION_V1, MAGIC_LENGTH);
  out.set(nonce, MAGIC_LENGTH + VERSION_LENGTH);
  out.set(ciphertext, HEADER_LENGTH);
  return out;
}

/**
 * Parse and decrypt an attachment blob. Throws on missing magic, short
 * blob, unknown version, or auth-tag failure — corrupt input never
 * returns partial data.
 */
export function decryptBuffer(blob: Buffer, key: Uint8Array): Buffer {
  if (blob.length < HEADER_LENGTH) {
    throw new Error(`encrypted attachment too short: ${blob.length} bytes`);
  }
  if (!isEncrypted(blob)) {
    throw new Error("encrypted attachment missing magic prefix");
  }
  const version = blob.readUInt16BE(MAGIC_LENGTH);
  if (version !== VERSION_V1) {
    throw new Error(`unknown encrypted-attachment version: ${version}`);
  }
  const nonce = new Uint8Array(blob.subarray(MAGIC_LENGTH + VERSION_LENGTH, HEADER_LENGTH));
  const ciphertext = new Uint8Array(blob.subarray(HEADER_LENGTH));
  return Buffer.from(decryptBytes(key, ciphertext, nonce));
}
