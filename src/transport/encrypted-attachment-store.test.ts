import { gcm } from "@noble/ciphers/aes.js";
import { describe, expect, it, vi } from "vitest";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../secrets/encryption.js";
import type { AttachmentStore } from "./attachment-store.js";
import {
  decryptBuffer,
  encryptBuffer,
  isEncrypted,
  wrapAttachmentStoreWithEncryption,
} from "./encrypted-attachment-store.js";

const PURPOSE = "cogmo/s3-attachments/v1";

const MAGIC = Buffer.from([0xc0, 0x6c, 0x6d, 0x6f]);
const HEADER_LENGTH = 4 + 2 + 12; // magic + version + nonce

function testKey(): Uint8Array {
  return deriveMasterKey(parseMasterKey(generateMasterKey()), PURPOSE);
}

interface UploadRecord {
  data: Buffer;
  mediaType: string;
  prefix?: string;
}

function fakeStore(): {
  store: AttachmentStore;
  uploads: UploadRecord[];
  blobs: Map<string, Buffer>;
} {
  const blobs = new Map<string, Buffer>();
  const uploads: UploadRecord[] = [];
  let i = 0;
  const store: AttachmentStore = {
    upload: vi.fn(async (data: Buffer, mediaType: string, prefix?: string) => {
      uploads.push({ data, mediaType, ...(prefix !== undefined && { prefix }) });
      const path = `${prefix ?? "inbound"}/blob-${i++}.bin`;
      blobs.set(path, data);
      return path;
    }),
    download: vi.fn(async (path: string) => {
      const blob = blobs.get(path);
      if (!blob) throw new Error(`Attachment not found: ${path}`);
      return blob;
    }),
  };
  return { store, uploads, blobs };
}

describe("encryptBuffer / decryptBuffer", () => {
  it("round-trips an arbitrary binary payload", () => {
    const key = testKey();
    const plaintext = Buffer.from([0x00, 0xff, 0x42, 0x13, 0x37, 0x00]);
    const blob = encryptBuffer(plaintext, key);
    expect(decryptBuffer(blob, key).equals(plaintext)).toBe(true);
  });

  it("emits the v1 header layout: [magic 4B][version 2B BE = 1][nonce 12B][cipher+tag]", () => {
    const key = testKey();
    const plaintext = Buffer.from("hello");
    const blob = encryptBuffer(plaintext, key);

    expect(blob.subarray(0, 4).equals(MAGIC)).toBe(true);
    expect(blob.readUInt16BE(4)).toBe(1);
    // total = magic (4) + version (2) + nonce (12) + plaintext + GCM tag (16)
    expect(blob.length).toBe(HEADER_LENGTH + plaintext.length + 16);
  });

  it("produces different ciphertexts for the same plaintext (random nonce)", () => {
    const key = testKey();
    const plaintext = Buffer.from("same input");
    const a = encryptBuffer(plaintext, key);
    const b = encryptBuffer(plaintext, key);
    expect(a.equals(b)).toBe(false);
  });

  it("rejects a tampered ciphertext byte", () => {
    const key = testKey();
    const blob = encryptBuffer(Buffer.from("secret"), key);
    const last = blob.length - 1;
    blob.writeUInt8(blob.readUInt8(last) ^ 0xff, last); // flip last byte (auth tag region)
    expect(() => decryptBuffer(blob, key)).toThrow();
  });

  it("rejects a tampered nonce byte", () => {
    const key = testKey();
    const blob = encryptBuffer(Buffer.from("secret"), key);
    // nonce sits at offset 6..18 — flip a byte inside that range
    blob.writeUInt8(blob.readUInt8(8) ^ 0xff, 8);
    expect(() => decryptBuffer(blob, key)).toThrow();
  });

  it("rejects the wrong key", () => {
    const blob = encryptBuffer(Buffer.from("secret"), testKey());
    expect(() => decryptBuffer(blob, testKey())).toThrow();
  });

  it("rejects an unknown version", () => {
    const blob = encryptBuffer(Buffer.from("secret"), testKey());
    blob.writeUInt16BE(0x9999, 4);
    expect(() => decryptBuffer(blob, testKey())).toThrow(/unknown encrypted-attachment version/);
  });

  it("rejects a blob that's missing the magic prefix entirely", () => {
    const blob = encryptBuffer(Buffer.from("secret"), testKey());
    blob.writeUInt8(0x00, 0); // clobber the first magic byte
    expect(() => decryptBuffer(blob, testKey())).toThrow(/missing magic prefix/);
  });

  it("rejects a too-short blob (less than the 18-byte header)", () => {
    expect(() => decryptBuffer(Buffer.from([0xc0, 0x6c, 0x6d, 0x6f]), testKey())).toThrow(
      /too short/,
    );
  });

  it("encrypts empty input — header + tag only, decrypts to empty", () => {
    const key = testKey();
    const blob = encryptBuffer(Buffer.alloc(0), key);
    // 4 magic + 2 version + 12 nonce + 0 plaintext + 16 GCM tag = 34
    expect(blob.length).toBe(34);
    expect(decryptBuffer(blob, key).length).toBe(0);
  });

  it("locks the v1 wire format — golden fixture against accidental drift", () => {
    // If someone reorders the magic bytes, flips version endianness, or
    // changes the nonce offset, this test fails. The (key, nonce,
    // plaintext) triple is fixed; the cipher comes from @noble/ciphers
    // directly so we're locking the envelope, not re-asserting the cipher.
    const key = new Uint8Array(32).fill(0x42);
    const nonce = new Uint8Array(12).fill(0x13);
    const plaintext = Buffer.from("test");
    const cipher = gcm(key, nonce).encrypt(new Uint8Array(plaintext));

    const blob = Buffer.concat([
      Buffer.from([0xc0, 0x6c, 0x6d, 0x6f]), // magic
      Buffer.from([0x00, 0x01]), // version=1, big-endian uint16
      Buffer.from(nonce), // 12-byte nonce
      Buffer.from(cipher), // ciphertext + 16-byte GCM tag
    ]);

    expect(decryptBuffer(blob, key).equals(plaintext)).toBe(true);
  });
});

describe("wrapAttachmentStoreWithEncryption", () => {
  it("encrypts on upload — inner store sees ciphertext, not plaintext", async () => {
    const key = testKey();
    const { store, uploads } = fakeStore();
    const wrapped = wrapAttachmentStoreWithEncryption(store, key);

    const plaintext = Buffer.from("the quick brown fox");
    await wrapped.upload(plaintext, "image/jpeg", "generated");

    expect(uploads).toHaveLength(1);
    const written = uploads[0];
    expect(written).toBeDefined();
    if (!written) throw new Error("unreachable");
    // The wrapper neutralizes the caller's media type — bucket sees
    // an opaque blob, not "image/jpeg" with ciphertext underneath.
    expect(written.mediaType).toBe("application/octet-stream");
    expect(written.prefix).toBe("generated");
    expect(written.data.includes(plaintext)).toBe(false);
    expect(written.data.subarray(0, 4).equals(MAGIC)).toBe(true);
    expect(written.data.readUInt16BE(4)).toBe(1);
  });

  it("pins inner-store media type to application/octet-stream regardless of caller value", async () => {
    const key = testKey();
    const { store, uploads } = fakeStore();
    const wrapped = wrapAttachmentStoreWithEncryption(store, key);

    await wrapped.upload(Buffer.from("a"), "image/png");
    await wrapped.upload(Buffer.from("b"), "audio/ogg");
    await wrapped.upload(Buffer.from("c"), "application/pdf");

    expect(uploads.map((u) => u.mediaType)).toEqual([
      "application/octet-stream",
      "application/octet-stream",
      "application/octet-stream",
    ]);
  });

  it("round-trips upload → download through the inner store", async () => {
    const key = testKey();
    const { store } = fakeStore();
    const wrapped = wrapAttachmentStoreWithEncryption(store, key);

    const plaintext = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x42]);
    const path = await wrapped.upload(plaintext, "application/octet-stream");
    const fetched = await wrapped.download(path);

    expect(fetched.equals(plaintext)).toBe(true);
  });

  it("preserves the path returned by the inner store", async () => {
    const key = testKey();
    const { store } = fakeStore();
    const wrapped = wrapAttachmentStoreWithEncryption(store, key);

    const path = await wrapped.upload(Buffer.from("x"), "text/plain", "generated");
    expect(path).toBe("generated/blob-0.bin");
  });

  it("forwards the prefix arg unchanged", async () => {
    const key = testKey();
    const { store, uploads } = fakeStore();
    const wrapped = wrapAttachmentStoreWithEncryption(store, key);

    await wrapped.upload(Buffer.from("a"), "text/plain");
    await wrapped.upload(Buffer.from("b"), "text/plain", "generated");

    expect(uploads[0]?.prefix).toBeUndefined();
    expect(uploads[1]?.prefix).toBe("generated");
  });

  it("throws on download when the wrong key is used", async () => {
    const { store } = fakeStore();
    const wrapped = wrapAttachmentStoreWithEncryption(store, testKey());
    const path = await wrapped.upload(Buffer.from("secret"), "text/plain");

    const otherWrapped = wrapAttachmentStoreWithEncryption(store, testKey());
    await expect(otherWrapped.download(path)).rejects.toThrow();
  });

  it("propagates inner-store errors (e.g. NoSuchKey)", async () => {
    const key = testKey();
    const { store } = fakeStore();
    const wrapped = wrapAttachmentStoreWithEncryption(store, key);

    await expect(wrapped.download("missing/path")).rejects.toThrow(/Attachment not found/);
  });
});

describe("isEncrypted", () => {
  it("matches a real v1 blob (magic prefix present)", () => {
    const blob = encryptBuffer(Buffer.from("payload"), testKey());
    expect(isEncrypted(blob)).toBe(true);
  });

  it("rejects empty buffers", () => {
    expect(isEncrypted(Buffer.alloc(0))).toBe(false);
  });

  it("rejects buffers shorter than the magic prefix", () => {
    expect(isEncrypted(Buffer.from([0xc0, 0x6c, 0x6d]))).toBe(false);
  });

  it.each([
    ["JPEG", [0xff, 0xd8, 0xff, 0xe0]],
    ["PNG", [0x89, 0x50, 0x4e, 0x47]],
    ["GIF", [0x47, 0x49, 0x46, 0x38]],
    ["WebP/RIFF", [0x52, 0x49, 0x46, 0x46]],
    ["PDF (%PDF)", [0x25, 0x50, 0x44, 0x46]],
    ["OGG (OggS)", [0x4f, 0x67, 0x67, 0x53]],
    ["UTF-8 text 'hello'", [0x68, 0x65, 0x6c, 0x6c]],
    ["leading 0x01 (old single-byte-magic collision case)", [0x01, 0x02, 0x03, 0x04]],
  ])("rejects %s prefix", (_, bytes) => {
    expect(isEncrypted(Buffer.from(bytes))).toBe(false);
  });

  it("rejects a near-miss where 3 of the 4 magic bytes match", () => {
    expect(isEncrypted(Buffer.from([0xc0, 0x6c, 0x6d, 0x00]))).toBe(false);
  });
});

describe("wrapAttachmentStoreWithEncryption — plaintext passthrough on read", () => {
  it("returns pre-flag plaintext blobs unchanged when the magic prefix is missing", async () => {
    // Simulate "flag flipped after the bucket already had plaintext images":
    // pre-seed the inner store with plaintext bytes, then read through the
    // encrypted wrapper.
    const { store, blobs } = fakeStore();
    const wrapped = wrapAttachmentStoreWithEncryption(store, testKey());

    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    blobs.set("inbound/legacy.jpg", jpegBytes);

    const fetched = await wrapped.download("inbound/legacy.jpg");
    expect(fetched.equals(jpegBytes)).toBe(true);
  });

  it.each([
    ["PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["PDF", Buffer.from("%PDF-1.4\n%...binary...", "utf-8")],
    ["short blob (1 byte)", Buffer.from([0x42])],
    ["empty", Buffer.alloc(0)],
    ["3-byte near-miss on the magic prefix", Buffer.from([0xc0, 0x6c, 0x6d])],
  ])("passes %s through untouched", async (_, plaintext) => {
    const { store, blobs } = fakeStore();
    const wrapped = wrapAttachmentStoreWithEncryption(store, testKey());
    blobs.set("legacy/blob", plaintext);

    const fetched = await wrapped.download("legacy/blob");
    expect(fetched.equals(plaintext)).toBe(true);
  });

  it("encrypts new uploads even when reads fall back to plaintext", async () => {
    // The flag's whole point: writes always encrypt. This test asserts
    // the read fallback does NOT relax the write side.
    const { store, blobs } = fakeStore();
    const wrapped = wrapAttachmentStoreWithEncryption(store, testKey());

    const path = await wrapped.upload(Buffer.from("new bytes"), "text/plain");
    const stored = blobs.get(path);
    expect(stored).toBeDefined();
    if (!stored) throw new Error("unreachable");
    expect(stored.subarray(0, 4).equals(MAGIC)).toBe(true);
    expect(stored.includes(Buffer.from("new bytes"))).toBe(false);
  });

  it("a plaintext object that happens to start with the magic prefix surfaces as a download error, not silent garbage", async () => {
    // Astronomically unlikely for real-world content but the failure mode
    // matters: the GCM auth-tag check fires once the wrapper commits to
    // the v1 layout, so the caller sees an error rather than corrupt bytes.
    const { store, blobs } = fakeStore();
    const wrapped = wrapAttachmentStoreWithEncryption(store, testKey());
    const fakeMagicMatch = Buffer.concat([
      MAGIC,
      Buffer.from([0x00, 0x01]), // version=1 to push past the version check
      Buffer.alloc(12), // nonce
      Buffer.alloc(20), // garbage cipher + tag
    ]);
    blobs.set("legacy/collision", fakeMagicMatch);

    await expect(wrapped.download("legacy/collision")).rejects.toThrow();
  });
});
