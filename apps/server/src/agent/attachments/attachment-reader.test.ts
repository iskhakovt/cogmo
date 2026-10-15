import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { createAttachmentReader } from "./attachment-reader.js";

describe("createAttachmentReader", () => {
  it("reads an object once per process and serves it as base64", async () => {
    const read = vi.fn().mockResolvedValue(ok(Buffer.from("pixels")));
    const reader = createAttachmentReader({ read }, 1_000);

    const first = await reader.readBase64("normalized/a.jpg");
    const second = await reader.readBase64("normalized/a.jpg");

    expect(first._unsafeUnwrap()).toBe(Buffer.from("pixels").toString("base64"));
    expect(second._unsafeUnwrap()).toBe(first._unsafeUnwrap());
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used object past its byte cap", async () => {
    // Each object is 8 bytes of base64; the cap holds two.
    const read = vi.fn(async (path: string) => ok(Buffer.from(path.padEnd(6, "_"))));
    const reader = createAttachmentReader({ read }, 16);

    await reader.readBase64("a");
    await reader.readBase64("b");
    await reader.readBase64("a");
    await reader.readBase64("c");
    await reader.readBase64("a");
    await reader.readBase64("b");

    expect(read.mock.calls.map(([path]) => path)).toEqual(["a", "b", "c", "b"]);
  });

  it("serves an object larger than the cap without keeping it", async () => {
    const read = vi.fn().mockResolvedValue(ok(Buffer.alloc(30)));
    const reader = createAttachmentReader({ read }, 16);

    await reader.readBase64("big");
    const again = await reader.readBase64("big");

    expect(again.isOk()).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("returns why an object can never be read", async () => {
    const reader = createAttachmentReader(
      { read: vi.fn().mockResolvedValue(err({ kind: "undecryptable" })) },
      16,
    );
    expect((await reader.readBase64("x"))._unsafeUnwrapErr()).toEqual({ kind: "undecryptable" });
  });

  it("propagates a transient failure and keeps nothing", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(ok(Buffer.from("ok")));
    const reader = createAttachmentReader({ read }, 16);

    await expect(reader.readBase64("x")).rejects.toThrow("timeout");
    expect((await reader.readBase64("x")).isOk()).toBe(true);
  });
});
