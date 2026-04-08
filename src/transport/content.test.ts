import { describe, expect, it } from "vitest";
import { contentToBlocks, contentToText } from "./content.js";

describe("contentToText", () => {
  it("passes strings through", () => {
    expect(contentToText("hello")).toBe("hello");
  });

  it("stringifies objects", () => {
    expect(contentToText({ foo: "bar" })).toBe('{"foo":"bar"}');
  });
});

describe("contentToBlocks", () => {
  it("converts string to TextBlock", () => {
    expect(contentToBlocks("hello")).toEqual([{ type: "text", text: "hello" }]);
  });

  it("converts array of strings", () => {
    expect(contentToBlocks(["a", "b"])).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
  });

  it("converts image reference with path to ImageRef", () => {
    const content = { type: "image", path: "inbound/abc.jpg", mediaType: "image/jpeg" };
    expect(contentToBlocks(content)).toEqual([
      { type: "image_ref", path: "inbound/abc.jpg", mediaType: "image/jpeg" },
    ]);
  });

  it("converts inline image with data to ImageBlock", () => {
    const content = {
      type: "image",
      source: "base64",
      data: "abc123",
      mediaType: "image/png",
    };
    expect(contentToBlocks(content)).toEqual([
      { type: "image", source: "base64", data: "abc123", mediaType: "image/png" },
    ]);
  });

  it("converts text object to TextBlock", () => {
    expect(contentToBlocks({ type: "text", text: "hello" })).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  it("converts mixed array (text + image ref)", () => {
    const content = [
      { type: "text", text: "caption" },
      { type: "image", path: "inbound/abc.jpg", mediaType: "image/jpeg" },
    ];
    expect(contentToBlocks(content)).toEqual([
      { type: "text", text: "caption" },
      { type: "image_ref", path: "inbound/abc.jpg", mediaType: "image/jpeg" },
    ]);
  });

  it("falls back to JSON.stringify for unknown objects", () => {
    expect(contentToBlocks({ unknown: true })).toEqual([
      { type: "text", text: '{"unknown":true}' },
    ]);
  });

  it("handles null", () => {
    expect(contentToBlocks(null)).toEqual([{ type: "text", text: "null" }]);
  });
});
