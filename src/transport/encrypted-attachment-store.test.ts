import { describe, expect, it, vi } from "vitest";
import { isEncrypted } from "../secrets/blob-envelope.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../secrets/encryption.js";
import type { AttachmentStore } from "./attachment-store.js";
import { wrapAttachmentStoreWithEncryption } from "./encrypted-attachment-store.js";

const PURPOSE = "cogmo/s3-objects/v1";

const MAGIC = Buffer.from([0xc0, 0x6c, 0x6d, 0x6f]);

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

  it("ciphertext written by the wrapper stays opaque when read directly through the bare inner store", async () => {
    // Simulates the operational footgun: operator flips S3_CLIENT_ENCRYPT
    // off after encrypting some files. Bare reads return raw ciphertext,
    // not silently-decrypted plaintext — the encryption is real and
    // persisted, not a wrapper-side illusion.
    const key = testKey();
    const { store } = fakeStore();
    const wrapped = wrapAttachmentStoreWithEncryption(store, key);

    const plaintext = Buffer.from("important plaintext");
    const path = await wrapped.upload(plaintext, "text/plain");

    const raw = await store.download(path);
    expect(raw.includes(plaintext)).toBe(false);
    expect(isEncrypted(raw)).toBe(true);
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
