import { describe, expect, it } from "vitest";
import {
  type ImageRefBlock,
  StoredMessageContentSchema,
  toStoredContent,
  toStoredMessage,
} from "./stored-content.js";

const photo: ImageRefBlock = {
  type: "image_ref",
  path: "normalized/a.jpg",
  mediaType: "image/jpeg",
  width: 2000,
  height: 1500,
  bytes: 812_345,
  name: "cat.jpg",
  original: { path: "inbound/a.heic", mediaType: "image/heic" },
};

describe("StoredMessageContentSchema", () => {
  it("round-trips refs, labels and placeholders", () => {
    const content = [
      { type: "text", text: "Image 1: normalized/a.jpg (cat.jpg)", harness: "image_label" },
      photo,
      {
        type: "document_ref",
        path: "inbound/r.txt",
        mediaType: "text/plain",
        name: "notes.txt",
        bytes: 100_000,
        original: { path: "inbound/r-full.txt", mediaType: "text/plain" },
      },
      { type: "text", text: "[photo: too large]", harness: "attachment_placeholder" },
      { type: "text", text: "what's this?" },
    ];
    expect(StoredMessageContentSchema.parse(content)).toEqual(content);
  });

  it("parses a JSON-string row from before refs as the string it is", () => {
    const legacy = JSON.stringify([
      { type: "image", path: "inbound/x.jpg", mediaType: "image/jpeg" },
    ]);
    expect(StoredMessageContentSchema.parse(legacy)).toBe(legacy);
  });

  it("rejects a base64 image or document block", () => {
    expect(
      StoredMessageContentSchema.safeParse([
        { type: "image", source: "base64", data: "AAAA", mediaType: "image/png" },
      ]).success,
    ).toBe(false);
    expect(
      StoredMessageContentSchema.safeParse([
        { type: "document", source: "base64", data: "AAAA", mediaType: "application/pdf" },
      ]).success,
    ).toBe(false);
  });

  it("rejects an image ref that isn't a normalized JPEG or PNG", () => {
    expect(
      StoredMessageContentSchema.safeParse([{ ...photo, mediaType: "image/heic" }]).success,
    ).toBe(false);
  });
});

describe("toStoredContent", () => {
  it("keeps every block a row can store", () => {
    const content = [
      { type: "thinking" as const, thinking: "hm", signature: "sig" },
      { type: "text" as const, text: "done" },
    ];
    expect(toStoredContent(content)).toEqual(content);
    expect(toStoredMessage({ role: "assistant", content: "ok" })).toEqual({
      role: "assistant",
      content: "ok",
    });
  });

  it("throws on a base64 attachment, which only a rendered ref carries", () => {
    expect(() =>
      toStoredContent([{ type: "image", source: "base64", data: "AAAA", mediaType: "image/png" }]),
    ).toThrow("store a ref instead");
  });
});
