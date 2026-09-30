import { describe, expect, it } from "vitest";
import { canonicalPromptTokens, cl100k, encodedLength } from "./tool-result-clearing.js";
import type { Message } from "./types.js";

describe("encodedLength", () => {
  it("counts a special-token marker as the text it is", () => {
    const enc = cl100k();

    expect(encodedLength(enc, "a <|endoftext|> b")).toBeGreaterThan(encodedLength(enc, "a  b"));
  });
});

describe("canonicalPromptTokens", () => {
  const base = { system: "sys", messages: [{ role: "user", content: "hi" }] satisfies Message[] };

  it("grows with every text-bearing block and with tool definitions", () => {
    const plain = canonicalPromptTokens(base);
    const withResult = canonicalPromptTokens({
      ...base,
      messages: [
        ...base.messages,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "/a" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "t1", content: "x ".repeat(200) }],
        },
      ],
    });
    const withTools = canonicalPromptTokens({
      ...base,
      tools: [{ name: "read", description: "Read a file.", parameters: { type: "object" } }],
    });

    expect(withResult).toBeGreaterThan(plain + 200);
    expect(withTools).toBeGreaterThan(plain);
  });

  it("takes an image at a flat figure, whatever its size", () => {
    const image = (data: string): Message => ({
      role: "user",
      content: [{ type: "image", source: "base64", data, mediaType: "image/png" }],
    });

    expect(canonicalPromptTokens({ ...base, messages: [image("a".repeat(10))] })).toBe(
      canonicalPromptTokens({ ...base, messages: [image("a".repeat(100_000))] }),
    );
  });
});
