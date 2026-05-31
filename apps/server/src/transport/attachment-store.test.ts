import { describe, expect, it } from "vitest";
import { mediaTypeToExt } from "./attachment-store.js";

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
