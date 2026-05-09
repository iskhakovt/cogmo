/**
 * V1 envelope format for at-rest binary encryption — used by both the
 * AttachmentStore and the FileService client-side encryption paths.
 *
 * Object body layout (single self-contained blob):
 *
 *   [magic 4B: 0xC0 0x6C 0x6D 0x6F] [version 2B BE] [nonce 12B] [ciphertext + GCM tag]
 *
 * Magic distinguishes encrypted blobs from plaintext objects uploaded
 * before the flag was flipped. `0xC0` is an invalid UTF-8 lead byte
 * (never a valid first byte of UTF-8 text) and combined with `lmo`
 * doesn't collide with the leading bytes of any common attachment
 * format (JPEG `0xFF`, PNG `0x89`, GIF `0x47`, WebP `0x52`, PDF `0x25`,
 * OGG `0x4F`). Collision probability for arbitrary plaintext is
 * ~1 in 2^32; zero for the file types this app actually handles.
 *
 * Version is a 2-byte big-endian uint16 separated from the magic so
 * future format changes (key rotation, AEAD swap) can roll forward
 * without changing the magic predicate. v1 is the only version today.
 *
 * See `design/infrastructure.md` → Secrets and the `S3_CLIENT_ENCRYPT`
 * env-var doc for the threat model and trade-offs.
 */

import { decryptBytes, encryptBytes } from "./encryption.js";

const MAGIC = Buffer.from([0xc0, 0x6c, 0x6d, 0x6f]);
const MAGIC_LENGTH = MAGIC.length;
const VERSION_LENGTH = 2;
const NONCE_LENGTH = 12;
const HEADER_LENGTH = MAGIC_LENGTH + VERSION_LENGTH + NONCE_LENGTH;

const VERSION_V1 = 1;

/**
 * Whether `blob` carries the Cogmo-encrypted-blob magic prefix.
 * Magic-only — does not validate the version, nonce, or ciphertext.
 * Version dispatch is `decryptBuffer`'s job.
 */
export function isEncrypted(blob: Buffer): boolean {
  return blob.length >= MAGIC_LENGTH && blob.subarray(0, MAGIC_LENGTH).equals(MAGIC);
}

/**
 * Format a v1 encrypted blob:
 *   [magic 4B] [version 2B BE] [nonce 12B] [ciphertext + GCM tag]
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
 * Parse and decrypt a v1 blob. Throws on missing magic, short blob,
 * unknown version, or auth-tag failure — corrupt input never returns
 * partial data.
 */
export function decryptBuffer(blob: Buffer, key: Uint8Array): Buffer {
  if (blob.length < HEADER_LENGTH) {
    throw new Error(`encrypted blob too short: ${blob.length} bytes`);
  }
  if (!isEncrypted(blob)) {
    throw new Error("encrypted blob missing magic prefix");
  }
  const version = blob.readUInt16BE(MAGIC_LENGTH);
  if (version !== VERSION_V1) {
    throw new Error(`unknown encrypted-blob version: ${version}`);
  }
  const nonce = new Uint8Array(blob.subarray(MAGIC_LENGTH + VERSION_LENGTH, HEADER_LENGTH));
  const ciphertext = new Uint8Array(blob.subarray(HEADER_LENGTH));
  return Buffer.from(decryptBytes(key, ciphertext, nonce));
}
