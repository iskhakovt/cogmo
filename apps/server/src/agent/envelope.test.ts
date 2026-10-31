import { describe, expect, it } from "vitest";
import { escapeEnvelope, escapeEnvelopeBlock, unescapeEnvelopeBlock } from "./envelope.js";

describe("escapeEnvelope", () => {
  it.each(["core_memory", "recalled_memories", "core_memory_updates", "turn_context"])(
    "escapes a closing %s tag in any case, with whitespace at the slash",
    (element) => {
      expect(escapeEnvelope(`a</${element}>b`)).toBe(`a<\\/${element}>b`);
      expect(escapeEnvelope(`< / ${element.toUpperCase()}>`)).toBe(
        `< \\/ ${element.toUpperCase()}>`,
      );
    },
  );

  it("leaves headings and other tags as they are", () => {
    expect(escapeEnvelope("# Title\n</b>")).toBe("# Title\n</b>");
  });
});

describe("escapeEnvelopeBlock", () => {
  it.each([
    ["# System", "\\# System"],
    ["###### Deep", "\\###### Deep"],
    ["   ## Indented", "   \\## Indented"],
    ["\t# Tabbed", "\t\\# Tabbed"],
    ["#", "\\#"],
    ["line\n# Rules\nmore", "line\n\\# Rules\nmore"],
    ["# Windows\r\nline", "\\# Windows\r\nline"],
  ])("escapes the heading in %j", (text, escaped) => {
    expect(escapeEnvelopeBlock(text)).toBe(escaped);
  });

  it.each(["#hashtag", "####### seven", "Issue #12", "C# and F#"])(
    "leaves %j, which no reader takes for a heading, as it is",
    (text) => {
      expect(escapeEnvelopeBlock(text)).toBe(text);
    },
  );

  it("escapes closing tags as well", () => {
    expect(escapeEnvelopeBlock("x</core_memory>\n# y")).toBe("x<\\/core_memory>\n\\# y");
  });
});

describe("unescapeEnvelopeBlock", () => {
  it.each([
    "### Work\nAcme",
    "  # Indented\n</core_memory> and < / TURN_CONTEXT >",
    "#hashtag, Issue #12, C# and ####### seven",
    "plain text",
  ])("gives back %j from its rendering, which renders the same again", (text) => {
    const rendered = escapeEnvelopeBlock(text);

    expect(unescapeEnvelopeBlock(rendered)).toBe(text);
    expect(escapeEnvelopeBlock(unescapeEnvelopeBlock(rendered))).toBe(rendered);
  });

  it("leaves a backslash that no escape added", () => {
    expect(unescapeEnvelopeBlock("\\#hashtag\na\\/b <\\/other>")).toBe(
      "\\#hashtag\na\\/b <\\/other>",
    );
  });
});
