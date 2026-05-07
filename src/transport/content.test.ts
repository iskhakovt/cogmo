import { describe, expect, it } from "vitest";
import { contentToBlocks, contentToText, isVoiceContent } from "./content.js";

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

  it("converts document-ref array element to DocumentRef", () => {
    expect(
      contentToBlocks([
        {
          type: "document",
          path: "inbound/abc.pdf",
          mediaType: "application/pdf",
          name: "report.pdf",
        },
      ]),
    ).toEqual([
      {
        type: "document_ref",
        path: "inbound/abc.pdf",
        mediaType: "application/pdf",
        name: "report.pdf",
      },
    ]);
  });

  it("omits name field on DocumentRef when caller omitted it", () => {
    expect(
      contentToBlocks([
        { type: "document", path: "inbound/abc.pdf", mediaType: "application/pdf" },
      ]),
    ).toEqual([{ type: "document_ref", path: "inbound/abc.pdf", mediaType: "application/pdf" }]);
  });

  it("converts inline-document array element to DocumentBlock", () => {
    expect(
      contentToBlocks([
        {
          type: "document",
          source: "base64",
          data: "ZmlsZQ==",
          mediaType: "text/plain",
          name: "notes.txt",
        },
      ]),
    ).toEqual([
      {
        type: "document",
        source: "base64",
        data: "ZmlsZQ==",
        mediaType: "text/plain",
        name: "notes.txt",
      },
    ]);
  });

  it("defaults inline-document source to 'base64' when omitted", () => {
    expect(
      contentToBlocks([{ type: "document", data: "ZmlsZQ==", mediaType: "application/pdf" }]),
    ).toEqual([
      { type: "document", source: "base64", data: "ZmlsZQ==", mediaType: "application/pdf" },
    ]);
  });

  it("converts mixed array (text + document ref)", () => {
    expect(
      contentToBlocks([
        { type: "text", text: "see attached" },
        {
          type: "document",
          path: "inbound/abc.pdf",
          mediaType: "application/pdf",
          name: "x.pdf",
        },
      ]),
    ).toEqual([
      { type: "text", text: "see attached" },
      {
        type: "document_ref",
        path: "inbound/abc.pdf",
        mediaType: "application/pdf",
        name: "x.pdf",
      },
    ]);
  });

  it("converts voice block to VoiceRef carrying durationMs", () => {
    expect(
      contentToBlocks([
        {
          type: "voice",
          path: "inbound/clip.ogg",
          mediaType: "audio/ogg",
          durationMs: 4200,
        },
      ]),
    ).toEqual([
      {
        type: "voice_ref",
        path: "inbound/clip.ogg",
        mediaType: "audio/ogg",
        durationMs: 4200,
      },
    ]);
  });

  it("converts voice block without durationMs (omits the field)", () => {
    expect(
      contentToBlocks([{ type: "voice", path: "inbound/clip.ogg", mediaType: "audio/ogg" }]),
    ).toEqual([{ type: "voice_ref", path: "inbound/clip.ogg", mediaType: "audio/ogg" }]);
  });

  it("converts mixed array (text + voice ref)", () => {
    expect(
      contentToBlocks([
        { type: "text", text: "listen" },
        { type: "voice", path: "inbound/clip.ogg", mediaType: "audio/ogg" },
      ]),
    ).toEqual([
      { type: "text", text: "listen" },
      { type: "voice_ref", path: "inbound/clip.ogg", mediaType: "audio/ogg" },
    ]);
  });
});

describe("isVoiceContent", () => {
  it("returns false for string content", () => {
    expect(isVoiceContent("hello")).toBe(false);
  });

  it("returns false for text-only block array", () => {
    expect(isVoiceContent([{ type: "text", text: "hi" }])).toBe(false);
  });

  it("returns false for image-only block array", () => {
    expect(isVoiceContent([{ type: "image", path: "p", mediaType: "image/png" }])).toBe(false);
  });

  it("returns true when any block is voice", () => {
    expect(isVoiceContent([{ type: "voice", path: "p", mediaType: "audio/ogg" }])).toBe(true);
  });

  it("returns true when voice is mixed with text", () => {
    expect(
      isVoiceContent([
        { type: "text", text: "listen" },
        { type: "voice", path: "p", mediaType: "audio/ogg" },
      ]),
    ).toBe(true);
  });
});
