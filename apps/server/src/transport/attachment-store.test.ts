import { NoSuchKey, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { expectDefined } from "../test/assertions.js";
import { createAttachmentStore, mediaTypeToExt } from "./attachment-store.js";

describe("mediaTypeToExt", () => {
  it.each([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
    ["image/svg+xml", "svg"],
    ["application/pdf", "pdf"],
    ["application/octet-stream", "bin"],
  ])("maps known media type %s to %s", (input, expected) => {
    expect(mediaTypeToExt(input)).toBe(expected);
  });

  it("falls back to the suffix of an unknown media type", () => {
    expect(mediaTypeToExt("audio/ogg")).toBe("ogg");
    expect(mediaTypeToExt("text/plain")).toBe("plain");
  });

  it("strips suffix modifiers (e.g. +xml)", () => {
    expect(mediaTypeToExt("application/atom+xml")).toBe("atom");
  });

  it("falls back to bin for malformed input", () => {
    expect(mediaTypeToExt("garbage")).toBe("bin");
    expect(mediaTypeToExt("")).toBe("bin");
  });
});

describe("createAttachmentStore().read", () => {
  function store(send: (command: unknown) => Promise<unknown>) {
    // Only `send` is exercised.
    return createAttachmentStore({ send } as unknown as S3Client, "bucket");
  }

  it("returns the object's bytes", async () => {
    const read = await store(async () => ({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    })).read("inbound/a.jpg");
    expect(read._unsafeUnwrap()).toEqual(Buffer.from([1, 2, 3]));
  });

  it("reports a missing key as missing, which no retry changes", async () => {
    const read = await store(async () => {
      throw new NoSuchKey({ message: "gone", $metadata: {} });
    }).read("inbound/a.jpg");
    expect(read._unsafeUnwrapErr()).toEqual({ kind: "missing" });
  });

  it("throws anything else, so the step retries it", async () => {
    const send = vi.fn().mockRejectedValue(new Error("socket hang up"));
    await expect(store(send).read("inbound/a.jpg")).rejects.toThrow("socket hang up");
  });
});

describe("createAttachmentStore().put", () => {
  it("writes the bytes under the caller's key with the media type", async () => {
    const send = vi.fn().mockResolvedValue({});
    const data = Buffer.from([1, 2, 3]);
    await createAttachmentStore({ send } as unknown as S3Client, "bucket").put(
      "inbound/a.normalized.jpg",
      data,
      "image/jpeg",
    );

    const command = expectDefined(send.mock.calls[0], "send call")[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: "bucket",
      Key: "inbound/a.normalized.jpg",
      Body: data,
      ContentType: "image/jpeg",
    });
  });
});
