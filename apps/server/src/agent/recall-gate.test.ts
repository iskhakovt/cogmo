import { describe, expect, it } from "vitest";
import { recallQueryText, shouldSkipRecall } from "./recall-gate.js";

describe("recallQueryText", () => {
  it("returns a text-only turn's rows as they are, joined by newline", () => {
    expect(
      recallQueryText([
        { content: "tell me about my homelab" },
        {
          content: [
            { type: "text", text: "the one in the loft" },
            { type: "text", text: "with the rack" },
          ],
        },
      ]),
    ).toBe("tell me about my homelab\nthe one in the loft\nwith the rack");
  });

  it("takes the caption of an image or document, not its block", () => {
    expect(
      recallQueryText([
        {
          content: [
            { type: "image", path: "inbound/cat.jpg", mediaType: "image/jpeg" },
            { type: "text", text: "what breed is this?" },
          ],
        },
        {
          content: [
            {
              type: "document",
              path: "inbound/a.pdf",
              mediaType: "application/pdf",
              name: "a.pdf",
            },
          ],
        },
        { content: "and summarize the report" },
      ]),
    ).toBe("what breed is this?\nand summarize the report");
  });

  it("is empty for a turn with no text", () => {
    expect(
      recallQueryText([
        { content: [{ type: "image", path: "inbound/cat.jpg", mediaType: "image/jpeg" }] },
      ]),
    ).toBe("");
  });
});

describe("shouldSkipRecall", () => {
  it.each(["off", "always", "heuristic", "llm"] as const)(
    "skips a message with no text in %s mode",
    (mode) => {
      expect(shouldSkipRecall(mode, "")).toBe(true);
      expect(shouldSkipRecall(mode, " \n ")).toBe(true);
    },
  );

  describe("off mode", () => {
    it("always skips", () => {
      expect(shouldSkipRecall("off", "what's my API key?")).toBe(true);
      expect(shouldSkipRecall("off", "")).toBe(true);
    });
  });

  describe("always mode", () => {
    it("never skips a message with text", () => {
      expect(shouldSkipRecall("always", "hi")).toBe(false);
      expect(shouldSkipRecall("always", "ok")).toBe(false);
    });
  });

  describe("llm mode (stub)", () => {
    it("falls through to always — never skips a message with text", () => {
      expect(shouldSkipRecall("llm", "hi")).toBe(false);
      expect(shouldSkipRecall("llm", "ok")).toBe(false);
    });
  });

  describe("heuristic mode", () => {
    describe("skips short messages", () => {
      it("empty string", () => expect(shouldSkipRecall("heuristic", "")).toBe(true));
      it("whitespace only", () => expect(shouldSkipRecall("heuristic", "   ")).toBe(true));
      it("single char", () => expect(shouldSkipRecall("heuristic", "k")).toBe(true));
      it("two chars", () => expect(shouldSkipRecall("heuristic", "ok")).toBe(true));
      it("emoji", () => expect(shouldSkipRecall("heuristic", "👍")).toBe(true));
    });

    describe("skips greetings and acks", () => {
      it.each(["hi", "Hello", "HEY", "thanks", "Thank you", "bye", "ty", "thx", "np"])(
        "skips '%s'",
        (msg) => expect(shouldSkipRecall("heuristic", msg)).toBe(true),
      );
    });

    describe("skips continuations", () => {
      it.each([
        "go ahead",
        "do it",
        "continue",
        "proceed",
        "sounds good",
        "LGTM",
        "perfect",
        "exactly",
        "Agreed",
        "correct",
      ])("skips '%s'", (msg) => expect(shouldSkipRecall("heuristic", msg)).toBe(true));
    });

    describe("does NOT skip informational messages", () => {
      it.each([
        "what's my API key?",
        "Alice's birthday?",
        "tell me about the project",
        "what did I say about that?",
        "yes, and also check the logs",
        "hi, what's the weather?",
        "ok so here's the plan",
        "thanks for that, now search for X",
        "hello world",
        "no way that's correct",
      ])("does not skip '%s'", (msg) => expect(shouldSkipRecall("heuristic", msg)).toBe(false));
    });

    it("handles leading/trailing whitespace", () => {
      expect(shouldSkipRecall("heuristic", "  hi  ")).toBe(true);
      expect(shouldSkipRecall("heuristic", "  go ahead  ")).toBe(true);
    });

    it("strips trailing punctuation before matching", () => {
      expect(shouldSkipRecall("heuristic", "thanks!")).toBe(true);
      expect(shouldSkipRecall("heuristic", "ok.")).toBe(true);
      expect(shouldSkipRecall("heuristic", "go ahead...")).toBe(true); // dots stripped
      expect(shouldSkipRecall("heuristic", "go ahead…")).toBe(true); // unicode ellipsis
      expect(shouldSkipRecall("heuristic", "sure!")).toBe(true);
      expect(shouldSkipRecall("heuristic", "yes!")).toBe(true);
    });
  });

  describe("unknown mode", () => {
    it("defaults to never skip (safe fallback)", () => {
      expect(shouldSkipRecall("invalid" as unknown as "always", "hi")).toBe(false);
    });
  });
});
