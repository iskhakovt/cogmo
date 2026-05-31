import { describe, expect, it } from "vitest";
import { ProviderProtocolError, parseProviderJson, parseToolArgs } from "./errors.js";

describe("parseProviderJson", () => {
  it("returns the parsed value when the input is valid JSON on first try", () => {
    const result = parseProviderJson(
      '{"query":"weather"}',
      "web_search",
      "Anthropic streamed tool_use input",
    );
    expect(result).toEqual({ query: "weather" });
  });

  it("repairs and parses trailing-comma JSON via jsonrepair before declaring failure", () => {
    const result = parseProviderJson(
      '{"query":"weather",}',
      "web_search",
      "Anthropic streamed tool_use input",
    );
    expect(result).toEqual({ query: "weather" });
  });

  it("throws ProviderProtocolError with .cause set to the repair error when neither pass succeeds", () => {
    // `}}}]]]` — closers-only with no payload, structurally unrepairable.
    let caught: unknown;
    try {
      parseProviderJson("}}}]]]", "web_search", "Anthropic streamed tool_use input");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProviderProtocolError);
    const protoErr = caught as ProviderProtocolError;

    // .cause points to the jsonrepair failure (the decisive error, named in
    // the message after "after jsonrepair:"), not the initial JSON.parse
    // SyntaxError. Both errors are visible in the message so a reader sees
    // the full attempt history without chasing .cause.
    expect(protoErr.cause).toBeInstanceOf(Error);
    expect(protoErr.cause).not.toBeInstanceOf(SyntaxError);
    expect(protoErr.message).toMatch(/initial: .+; after jsonrepair: /);
    expect(protoErr.message).toContain('"web_search"');
    expect(protoErr.message).toContain("Anthropic streamed tool_use input");
  });
});

describe("parseToolArgs", () => {
  it("returns {} for empty string (canonical zero-arg shape)", () => {
    expect(parseToolArgs("", "btc_spot", "ctx")).toEqual({});
  });

  it("returns {} for whitespace-only input", () => {
    expect(parseToolArgs("   \n\t ", "btc_spot", "ctx")).toEqual({});
  });

  it("parses well-formed JSON via parseProviderJson", () => {
    expect(parseToolArgs('{"q":"x"}', "search", "ctx")).toEqual({ q: "x" });
  });

  it("propagates ProviderProtocolError for unrepairable input — empty-check doesn't mask real bugs", () => {
    expect(() => parseToolArgs("}}}]]]", "search", "ctx")).toThrow(ProviderProtocolError);
  });
});
