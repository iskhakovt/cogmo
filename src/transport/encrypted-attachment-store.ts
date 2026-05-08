/**
 * Client-side encryption wrapper around `AttachmentStore`.
 *
 * Wraps `upload` / `download` with AES-256-GCM so the underlying S3 /
 * R2 bucket only ever sees ciphertext. The key is derived from
 * `COGMO_MASTER_KEY` via HKDF (purpose `cogmo/s3-attachments/v1`),
 * mirroring the secrets-at-rest pattern.
 *
 * Object body layout (single self-contained blob):
 *   [version (1B)] [nonce (12B)] [ciphertext + GCM tag]
 *
 * The version byte lets a future format change roll forward without a
 * re-encryption migration: the decoder fans out on the leading byte and
 * picks the matching cipher / nonce / tag layout. v1 is the only format
 * today.
 *
 * See `design/infrastructure.md` → Secrets and the `S3_CLIENT_ENCRYPT`
 * todo for the threat model and trade-offs.
 */

import { decryptBytes, encryptBytes } from "../secrets/encryption.js";
import type { AttachmentStore } from "./attachment-store.js";

const VERSION_V1 = 0x01;
const NONCE_LENGTH = 12;
const HEADER_LENGTH = 1 + NONCE_LENGTH;

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
    async upload(data: Buffer, mediaType: string, prefix?: string): Promise<string> {
      const encrypted = encryptBuffer(data, key);
      return inner.upload(encrypted, mediaType, prefix);
    },

    async download(path: string): Promise<Buffer> {
      const blob = await inner.download(path);
      return decryptBuffer(blob, key);
    },
  };
}

/**
 * Format an encrypted attachment blob: `[ver][nonce][ciphertext+tag]`.
 * Exported for tests; production callers use the wrapper.
 */
export function encryptBuffer(plaintext: Buffer, key: Uint8Array): Buffer {
  const { ciphertext, nonce } = encryptBytes(key, new Uint8Array(plaintext));
  const out = Buffer.allocUnsafe(HEADER_LENGTH + ciphertext.length);
  out[0] = VERSION_V1;
  out.set(nonce, 1);
  out.set(ciphertext, HEADER_LENGTH);
  return out;
}

/**
 * Parse and decrypt an attachment blob. Throws on unknown version, short
 * blob, or auth-tag failure — corrupt input never returns partial data.
 */
export function decryptBuffer(blob: Buffer, key: Uint8Array): Buffer {
  if (blob.length < HEADER_LENGTH) {
    throw new Error(`encrypted attachment too short: ${blob.length} bytes`);
  }
  const version = blob[0];
  if (version !== VERSION_V1) {
    throw new Error(`unknown encrypted-attachment version: ${version}`);
  }
  const nonce = new Uint8Array(blob.subarray(1, HEADER_LENGTH));
  const ciphertext = new Uint8Array(blob.subarray(HEADER_LENGTH));
  return Buffer.from(decryptBytes(key, ciphertext, nonce));
}
