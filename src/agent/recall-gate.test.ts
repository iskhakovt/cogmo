import { describe, expect, it } from "vitest";
import { shouldSkipRecall } from "./recall-gate.js";

describe("shouldSkipRecall", () => {
  describe("off mode", () => {
    it("always skips", () => {
      expect(shouldSkipRecall("off", "what's my API key?")).toBe(true);
      expect(shouldSkipRecall("off", "")).toBe(true);
    });
  });

  describe("always mode", () => {
    it("never skips", () => {
      expect(shouldSkipRecall("always", "hi")).toBe(false);
      expect(shouldSkipRecall("always", "ok")).toBe(false);
      expect(shouldSkipRecall("always", "")).toBe(false);
    });
  });

  describe("llm mode (stub)", () => {
    it("falls through to always — never skips", () => {
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
      it.each([
        "hi",
        "Hello",
        "HEY",
        "thanks",
        "Thank you",
        "bye",
        "ty",
        "thx",
        "np",
      ])("skips '%s'", (msg) => expect(shouldSkipRecall("heuristic", msg)).toBe(true));
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
  });

  describe("unknown mode", () => {
    it("defaults to never skip (safe fallback)", () => {
      expect(shouldSkipRecall("invalid" as unknown as "always", "hi")).toBe(false);
    });
  });
});
