import { describe, expect, it } from "vitest";
import {
  decrypt,
  deriveMasterKey,
  encrypt,
  fromBase64,
  generateMasterKey,
  parseMasterKey,
  toBase64,
} from "./encryption.js";

const PURPOSE = "cogmo/secrets-at-rest/v1";

function testKey(): Uint8Array {
  return deriveMasterKey(parseMasterKey(generateMasterKey()), PURPOSE);
}

describe("encryption", () => {
  it("round-trips plaintext through encrypt/decrypt", () => {
    const key = testKey();
    const plaintext = "sk-ant-api03-secret-key-value";
    const { ciphertext, nonce } = encrypt(key, plaintext);
    const result = decrypt(key, ciphertext, nonce);
    expect(result).toBe(plaintext);
  });

  it("handles empty plaintext", () => {
    const key = testKey();
    const { ciphertext, nonce } = encrypt(key, "");
    expect(decrypt(key, ciphertext, nonce)).toBe("");
  });

  it("handles unicode plaintext", () => {
    const key = testKey();
    const plaintext = "🔑 пароль 密钥";
    const { ciphertext, nonce } = encrypt(key, plaintext);
    expect(decrypt(key, ciphertext, nonce)).toBe(plaintext);
  });

  it("produces different nonces for each encryption", () => {
    const key = testKey();
    const a = encrypt(key, "same");
    const b = encrypt(key, "same");
    expect(a.nonce).not.toEqual(b.nonce);
    // Ciphertexts also differ (different nonces → different output)
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it("throws on wrong key", () => {
    const key1 = testKey();
    const key2 = testKey();
    const { ciphertext, nonce } = encrypt(key1, "secret");
    expect(() => decrypt(key2, ciphertext, nonce)).toThrow();
  });

  it("throws on tampered ciphertext", () => {
    const key = testKey();
    const { ciphertext, nonce } = encrypt(key, "secret");
    if (ciphertext[0] === undefined) throw new Error("expected non-empty ciphertext");
    ciphertext[0] ^= 0xff; // flip a byte
    expect(() => decrypt(key, ciphertext, nonce)).toThrow();
  });

  it("throws on tampered nonce", () => {
    const key = testKey();
    const { ciphertext, nonce } = encrypt(key, "secret");
    if (nonce[0] === undefined) throw new Error("expected non-empty nonce");
    nonce[0] ^= 0xff;
    expect(() => decrypt(key, ciphertext, nonce)).toThrow();
  });
});

describe("deriveMasterKey", () => {
  it("is deterministic for the same input", () => {
    const raw = parseMasterKey(generateMasterKey());
    const a = deriveMasterKey(raw, PURPOSE);
    const b = deriveMasterKey(raw, PURPOSE);
    expect(a).toEqual(b);
  });

  it("produces different keys for different purposes", () => {
    const raw = parseMasterKey(generateMasterKey());
    const a = deriveMasterKey(raw, "cogmo/secrets-at-rest/v1");
    const b = deriveMasterKey(raw, "cogmo/webhook-hmac/v1");
    expect(a).not.toEqual(b);
  });

  it("produces different keys for different master keys", () => {
    const raw1 = parseMasterKey(generateMasterKey());
    const raw2 = parseMasterKey(generateMasterKey());
    const a = deriveMasterKey(raw1, PURPOSE);
    const b = deriveMasterKey(raw2, PURPOSE);
    expect(a).not.toEqual(b);
  });
});

describe("parseMasterKey", () => {
  it("parses a valid 32-byte base64 key", () => {
    const key = generateMasterKey();
    const parsed = parseMasterKey(key);
    expect(parsed.length).toBe(32);
  });

  it("throws on wrong length", () => {
    const short = Buffer.from("too-short").toString("base64");
    expect(() => parseMasterKey(short)).toThrow(/must be 32 bytes/);
  });
});

describe("toBase64 / fromBase64", () => {
  it("round-trips Uint8Array", () => {
    const original = new Uint8Array([1, 2, 3, 255, 0, 128]);
    const encoded = toBase64(original);
    expect(typeof encoded).toBe("string");
    const decoded = fromBase64(encoded);
    expect(decoded).toEqual(original);
  });
});
