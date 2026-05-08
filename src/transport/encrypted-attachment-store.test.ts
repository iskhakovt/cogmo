import { describe, expect, it, vi } from "vitest";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../secrets/encryption.js";
import type { AttachmentStore } from "./attachment-store.js";
import {
  decryptBuffer,
  encryptBuffer,
  wrapAttachmentStoreWithEncryption,
} from "./encrypted-attachment-store.js";

const PURPOSE = "cogmo/s3-attachments/v1";

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

  it("emits the v1 header layout: [ver=0x01][nonce 12B][cipher+tag]", () => {
    const key = testKey();
    const plaintext = Buffer.from("hello");
    const blob = encryptBuffer(plaintext, key);
    expect(blob[0]).toBe(0x01);
    // nonce is bytes 1..13, ciphertext is the rest
    expect(blob.length).toBe(1 + 12 + plaintext.length + 16); // +16 for GCM tag
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
    blob.writeUInt8(blob.readUInt8(5) ^ 0xff, 5); // flip a nonce byte
    expect(() => decryptBuffer(blob, key)).toThrow();
  });

  it("rejects the wrong key", () => {
    const blob = encryptBuffer(Buffer.from("secret"), testKey());
    expect(() => decryptBuffer(blob, testKey())).toThrow();
  });

  it("rejects an unknown version byte", () => {
    const blob = encryptBuffer(Buffer.from("secret"), testKey());
    blob[0] = 0x99;
    expect(() => decryptBuffer(blob, testKey())).toThrow(/unknown encrypted-attachment version/);
  });

  it("rejects a too-short blob", () => {
    expect(() => decryptBuffer(Buffer.from([0x01, 0x02]), testKey())).toThrow(/too short/);
  });
});

describe("wrapAttachmentStoreWithEncryption", () => {
  it("encrypts on upload — inner store sees ciphertext, not plaintext", async () => {
    const key = testKey();
    const { store, uploads } = fakeStore();
    const wrapped = wrapAttachmentStoreWithEncryption(store, key);

    const plaintext = Buffer.from("the quick brown fox");
    await wrapped.upload(plaintext, "text/plain", "generated");

    expect(uploads).toHaveLength(1);
    const written = uploads[0];
    expect(written).toBeDefined();
    if (!written) throw new Error("unreachable");
    expect(written.mediaType).toBe("text/plain");
    expect(written.prefix).toBe("generated");
    // The inner store must not see the plaintext anywhere in its bytes.
    expect(written.data.includes(plaintext)).toBe(false);
    // It must look like a v1 blob.
    expect(written.data[0]).toBe(0x01);
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
