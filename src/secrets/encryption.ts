/**
 * AES-256-GCM encryption for secrets at rest.
 *
 * Uses @noble/ciphers for the AEAD cipher (Cure53-audited, stateless API)
 * and @noble/hashes for HKDF key derivation (purpose separation + versioning).
 *
 * See design/infrastructure.md → Secrets for the design rationale.
 */

import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** Fixed salt for HKDF — not secret, just domain separation. */
const HKDF_SALT = sha256(new TextEncoder().encode("cogmo")).subarray(0, 32);

/** Standard GCM nonce length (96 bits, NIST SP 800-38D recommended). */
const NONCE_LENGTH = 12;

/** Derived key length (256 bits for AES-256). */
const KEY_LENGTH = 32;

/**
 * Derive a purpose-scoped key from the master key via HKDF-SHA256.
 *
 * Each purpose string (e.g., "cogmo/secrets-at-rest/v1") produces an
 * independent, cryptographically isolated key. If one derived key leaks,
 * the others are unaffected.
 */
export function deriveMasterKey(rawKey: Uint8Array, purpose: string): Uint8Array {
  return hkdf(sha256, rawKey, HKDF_SALT, new TextEncoder().encode(purpose), KEY_LENGTH);
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 *
 * Returns the ciphertext (with appended auth tag) and a random 12-byte nonce.
 * The caller must store both — the nonce is not secret but is required for
 * decryption.
 */
export function encrypt(
  key: Uint8Array,
  plaintext: string,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = randomBytes(NONCE_LENGTH);
  const ciphertext = gcm(key, nonce).encrypt(new TextEncoder().encode(plaintext));
  return { ciphertext, nonce };
}

/**
 * Decrypt an AES-256-GCM ciphertext back to a plaintext string.
 *
 * Throws if the key, nonce, or ciphertext is wrong (auth tag verification
 * fails). Never returns corrupted data — it's all-or-nothing.
 */
export function decrypt(key: Uint8Array, ciphertext: Uint8Array, nonce: Uint8Array): string {
  const plaintext = gcm(key, nonce).decrypt(ciphertext);
  return new TextDecoder().decode(plaintext);
}

/** Parse a base64-encoded master key into raw bytes. */
export function parseMasterKey(base64: string): Uint8Array {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length !== KEY_LENGTH) {
    throw new Error(
      `Master key must be ${KEY_LENGTH} bytes (got ${bytes.length}). Generate one with: cogmo gen-key`,
    );
  }
  return new Uint8Array(bytes);
}

/** Generate a fresh 32-byte master key, returned as a base64 string. */
export function generateMasterKey(): string {
  return Buffer.from(randomBytes(KEY_LENGTH)).toString("base64");
}

/** Encode a Uint8Array as a base64 string (for DB storage as text). */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Decode a base64 string back to a Uint8Array (from DB storage). */
export function fromBase64(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}
