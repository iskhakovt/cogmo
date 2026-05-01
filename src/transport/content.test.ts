import { describe, expect, it } from "vitest";
import { contentToBlocks, contentToText } from "./content.js";

describe("contentToText", () => {
  it("passes strings through", () => {
    expect(contentToText("hello")).toBe("hello");
  });

  it("stringifies block arrays", () => {
    expect(contentToText([{ type: "text", text: "hi" }])).toBe('[{"type":"text","text":"hi"}]');
  });
});

describe("contentToBlocks", () => {
  it("converts string to TextBlock", () => {
    expect(contentToBlocks("hello")).toEqual([{ type: "text", text: "hello" }]);
  });

  it("converts image-ref array element to ImageRef", () => {
    expect(
      contentToBlocks([{ type: "image", path: "inbound/abc.jpg", mediaType: "image/jpeg" }]),
    ).toEqual([{ type: "image_ref", path: "inbound/abc.jpg", mediaType: "image/jpeg" }]);
  });

  it("converts inline-image array element to ImageBlock", () => {
    expect(
      contentToBlocks([
        { type: "image", source: "base64", data: "abc123", mediaType: "image/png" },
      ]),
    ).toEqual([{ type: "image", source: "base64", data: "abc123", mediaType: "image/png" }]);
  });

  it("defaults inline-image source to 'base64' when omitted", () => {
    expect(contentToBlocks([{ type: "image", data: "abc123", mediaType: "image/png" }])).toEqual([
      { type: "image", source: "base64", data: "abc123", mediaType: "image/png" },
    ]);
  });

  it("converts mixed array (text + image ref)", () => {
    expect(
      contentToBlocks([
        { type: "text", text: "caption" },
        { type: "image", path: "inbound/abc.jpg", mediaType: "image/jpeg" },
      ]),
    ).toEqual([
      { type: "text", text: "caption" },
      { type: "image_ref", path: "inbound/abc.jpg", mediaType: "image/jpeg" },
    ]);
  });
});
