import { describe, expect, it } from "vitest";
import { stringifyWellFormedJson } from "./helpers.js";

describe("stringifyWellFormedJson", () => {
  const COLUMN = "content";

  it("matches JSON.stringify for well-formed values", () => {
    const value = { a: 1, b: ["x", null, true], c: { d: "é😀" } };
    expect(stringifyWellFormedJson(value, COLUMN)).toBe(JSON.stringify(value));
  });

  // Postgres rejects an escaped lone surrogate with 22P02 ("Unicode low
  // surrogate must follow a high surrogate"). The write happens after the
  // turn's tool side effects have run, so an unsanitized value is a poison
  // pill: every Inngest retry fails identically.
  it("replaces a lone surrogate in a string value with U+FFFD", () => {
    const encoded = stringifyWellFormedJson({ q: "bad\uD800end" }, COLUMN);
    expect(encoded).not.toMatch(/\\ud[89a-f]/i);
    expect(JSON.parse(encoded)).toEqual({ q: "bad�end" });
  });

  it("replaces a lone surrogate in an object key with U+FFFD", () => {
    const encoded = stringifyWellFormedJson({ "k\uDC00": "v" }, COLUMN);
    expect(encoded).not.toMatch(/\\ud[89a-f]/i);
    expect(JSON.parse(encoded)).toEqual({ "k�": "v" });
  });

  it("reaches lone surrogates nested inside arrays and objects", () => {
    const encoded = stringifyWellFormedJson(
      [{ type: "tool_use", input: { nested: ["ok", "x\uD800"] } }],
      COLUMN,
    );
    expect(encoded).not.toMatch(/\\ud[89a-f]/i);
    expect(JSON.parse(encoded)).toEqual([{ type: "tool_use", input: { nested: ["ok", "x�"] } }]);
  });

  it("leaves well-formed surrogate pairs intact", () => {
    const value = { q: "😀🎉" };
    expect(JSON.parse(stringifyWellFormedJson(value, COLUMN))).toEqual(value);
  });

  // The fast-negative regex runs over encoded text, where a backslash in the
  // source string is itself escaped — so `\ud800` as literal characters looks
  // like an escape and triggers the sanitising pass. That pass must be a
  // no-op on it.
  it("does not corrupt a string whose text spells a surrogate escape", () => {
    const value = { pattern: "\\ud800 matches high surrogates" };
    expect(stringifyWellFormedJson(value, COLUMN)).toBe(JSON.stringify(value));
  });

  it("leaves values with their own toJSON to serialize themselves", () => {
    const at = new Date("2026-01-02T03:04:05.000Z");
    expect(stringifyWellFormedJson({ at, q: "x\uD800" }, COLUMN)).toBe(
      JSON.stringify({ at, q: "x�" }),
    );
  });
});
