import { describe, expect, it } from "vitest";
import {
  canonicalizeToolInputs,
  extractText,
  isHarnessPrompt,
  isTurnRowContent,
  NOT_TURN_ROW_JSONPATH,
} from "./content.js";
import { type ContentBlock, HARNESS_ROW_TAGS } from "./types.js";

describe("canonicalizeToolInputs", () => {
  it("sorts every tool_use input's keys and keeps the values", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "draw", input: { prompt: "p", model: "m" } },
      { type: "tool_use", id: "t2", name: "draw", input: { z: [{ b: 1, a: 2 }], y: null } },
    ];

    const result = canonicalizeToolInputs(content);

    expect(JSON.stringify(result)).toBe(
      '[{"type":"tool_use","id":"t1","name":"draw","input":{"model":"m","prompt":"p"}},' +
        '{"type":"tool_use","id":"t2","name":"draw","input":{"y":null,"z":[{"a":2,"b":1}]}}]',
    );
    expect(result).toEqual(content);
  });

  it("passes every other block through, in order", () => {
    const content: ContentBlock[] = [
      { type: "thinking", thinking: "plan", signature: "sig" },
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "t1", name: "echo", input: { b: 1, a: 2 } },
      { type: "text", text: "Then." },
    ];

    const result = canonicalizeToolInputs(content);

    expect(result.map((b) => b.type)).toEqual(["thinking", "text", "tool_use", "text"]);
    expect(result[0]).toBe(content[0]);
    expect(result[1]).toBe(content[1]);
    expect(result[3]).toBe(content[3]);
  });

  it("leaves its argument untouched", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "echo", input: { b: 1, a: 2 } },
    ];
    const before = JSON.stringify(content);

    const result = canonicalizeToolInputs(content);

    expect(result).not.toBe(content);
    expect(JSON.stringify(content)).toBe(before);
  });
});

describe("extractText", () => {
  it("returns string content unchanged", () => {
    expect(extractText("  plain reply\n")).toBe("  plain reply\n");
  });

  it("concatenates text blocks verbatim, with no separator of its own", () => {
    expect(
      extractText([
        { type: "text", text: "Step one. " },
        { type: "text", text: "Step two.\n\n" },
        { type: "text", text: "[cut off]" },
      ]),
    ).toBe("Step one. Step two.\n\n[cut off]");
  });

  it("skips every non-text block", () => {
    expect(
      extractText([
        { type: "thinking", thinking: "plan", signature: "sig" },
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "t1", name: "echo", input: {} },
        { type: "tool_result", toolUseId: "t1", content: "not prose" },
      ]),
    ).toBe("Checking.");
  });

  it("returns an empty string when there is no text", () => {
    expect(extractText([])).toBe("");
    expect(extractText([{ type: "tool_use", id: "t1", name: "echo", input: {} }])).toBe("");
  });
});

describe("isTurnRowContent", () => {
  it("takes a string, or a block array with no tool result and no harness-row tag", () => {
    expect(isTurnRowContent("hello")).toBe(true);
    expect(isTurnRowContent([{ type: "text", text: "look at this" }])).toBe(true);
  });

  it.each(HARNESS_ROW_TAGS)("refuses a row carrying a %s block", (tag) => {
    expect(isTurnRowContent([{ type: "text", text: "x", harness: tag }])).toBe(false);
  });

  it("refuses a tool-result row", () => {
    expect(isTurnRowContent([{ type: "tool_result", toolUseId: "t1", content: "ok" }])).toBe(false);
  });

  it("names every harness-row tag in the SQL path", () => {
    for (const tag of HARNESS_ROW_TAGS) {
      expect(NOT_TURN_ROW_JSONPATH).toContain(`@.harness == "${tag}"`);
    }
  });
});

describe("isHarnessPrompt", () => {
  it("reports the continuation prompt and the nudge, not the truncation notice", () => {
    expect(isHarnessPrompt({ type: "text", text: "x", harness: "continuation" })).toBe(true);
    expect(
      isHarnessPrompt({
        type: "tool_result",
        toolUseId: "t1",
        content: "x",
        harness: "volume_nudge",
      }),
    ).toBe(true);
    expect(isHarnessPrompt({ type: "text", text: "x", harness: "truncation_notice" })).toBe(false);
    expect(isHarnessPrompt({ type: "text", text: "x" })).toBe(false);
  });
});
