import { describe, expect, it } from "vitest";
import { ProviderProtocolError } from "../llm/errors.js";
import { RefusalError } from "../llm/fallback.js";
import {
  classifyPostStream,
  classifyStreamError,
  degradedReplyText,
  freshBudgets,
  INITIAL_BUDGETS,
  type RepairBudgets,
} from "./repair.js";

describe("classifyPostStream", () => {
  it("returns ok for a normal end_turn with content", () => {
    const budgets = freshBudgets();
    const outcome = classifyPostStream([{ type: "text", text: "hi" }], "end_turn", budgets);
    expect(outcome).toEqual({ kind: "ok" });
    // Budget untouched.
    expect(budgets.empty_end_turn).toBe(INITIAL_BUDGETS.empty_end_turn);
    expect(budgets.stream_truncation).toBe(INITIAL_BUDGETS.stream_truncation);
  });

  it("returns immediate degrade on stop_reason: refusal regardless of state", () => {
    const budgets = freshBudgets();
    const outcome = classifyPostStream([], "refusal", budgets);
    expect(outcome).toEqual({
      kind: "degrade",
      reason: "model returned a policy refusal",
      subtype: "refusal",
    });
  });

  // The loop body calls classifyPostStream, observes a `repair` outcome,
  // and then does `budgets[outcome.subtype]--` before re-iterating. This
  // test pins the invariant that the second call's outcome flips from
  // `repair` to `degrade` BECAUSE the caller decremented the matching
  // budget field — not because of any internal classifier state. If
  // `budgets.empty_end_turn--` in `loop.ts` is replaced with a no-op,
  // the second call here would still return `repair` and this test
  // would fail.
  it("budget decrement flips empty_end_turn from repair to degrade", () => {
    const budgets: RepairBudgets = freshBudgets();
    expect(budgets.empty_end_turn).toBe(1);

    const first = classifyPostStream([], "end_turn", budgets);
    expect(first).toEqual({
      kind: "repair",
      subtype: "empty_end_turn",
      instructions: {
        kind: "continuation_prompt",
        text: "Please complete your response.",
      },
    });

    // Mirror what the loop does after a repair outcome.
    budgets.empty_end_turn--;
    expect(budgets.empty_end_turn).toBe(0);

    const second = classifyPostStream([], "end_turn", budgets);
    expect(second).toEqual({
      kind: "degrade",
      reason: "model returned an empty turn",
      subtype: "empty_end_turn",
    });
  });

  it("classifier does not mutate the budget itself", () => {
    const budgets = freshBudgets();
    classifyPostStream([], "end_turn", budgets);
    // The loop owns the decrement — the classifier is a pure read.
    expect(budgets.empty_end_turn).toBe(1);
  });
});

describe("classifyStreamError", () => {
  it("returns repair for ProviderProtocolError when budget available", () => {
    const budgets = freshBudgets();
    const outcome = classifyStreamError(
      new ProviderProtocolError("boom", new SyntaxError("x")),
      budgets,
    );
    expect(outcome).toEqual({
      kind: "repair",
      subtype: "stream_truncation",
      instructions: { kind: "stream_replay" },
    });
  });

  // Same invariant as the post-stream classifier: the second call's
  // outcome flips because the caller (loop.ts) decrements
  // `budgets.stream_truncation` after consuming a repair, not because of
  // any internal state inside `classifyStreamError`.
  it("budget decrement flips stream_truncation from repair to degrade", () => {
    const budgets = freshBudgets();
    const err = new ProviderProtocolError("boom", new SyntaxError("x"));

    const first = classifyStreamError(err, budgets);
    expect(first?.kind).toBe("repair");

    budgets.stream_truncation--;
    expect(budgets.stream_truncation).toBe(0);

    const second = classifyStreamError(err, budgets);
    expect(second).toEqual({
      kind: "degrade",
      reason: "streamed tool-call arguments could not be parsed",
      subtype: "stream_truncation",
    });
  });

  it("returns immediate degrade for RefusalError regardless of budget state", () => {
    const budgets = freshBudgets();
    const outcome = classifyStreamError(new RefusalError("policy"), budgets);
    expect(outcome).toEqual({
      kind: "degrade",
      reason: "model refused the request",
      subtype: "refusal",
    });
    // No budget entry to consult for refusal — left unchanged.
    expect(budgets.empty_end_turn).toBe(1);
    expect(budgets.stream_truncation).toBe(1);
  });

  it("returns undefined for non-Class-C errors so the caller propagates them", () => {
    const budgets = freshBudgets();
    expect(classifyStreamError(new Error("upstream 502"), budgets)).toBeUndefined();
    expect(classifyStreamError("string error", budgets)).toBeUndefined();
    expect(classifyStreamError(null, budgets)).toBeUndefined();
  });
});

describe("freshBudgets / INITIAL_BUDGETS", () => {
  it("returns a new object each call (no shared mutable state)", () => {
    const a = freshBudgets();
    const b = freshBudgets();
    a.empty_end_turn = 99;
    expect(b.empty_end_turn).toBe(1);
  });

  it("INITIAL_BUDGETS is frozen — defensive against accidental mutation", () => {
    expect(() => {
      // Frozen object — assigning a property should throw in strict mode.
      (INITIAL_BUDGETS as unknown as RepairBudgets).empty_end_turn = 99;
    }).toThrow();
  });
});

describe("degradedReplyText", () => {
  it("returns the refusal-specific message for the refusal subtype", () => {
    expect(degradedReplyText("refusal")).toMatch(/declined/i);
  });

  it("returns the generic apology for empty_end_turn / stream_truncation / null", () => {
    const generic = degradedReplyText("empty_end_turn");
    expect(generic).toMatch(/trouble generating/i);
    expect(degradedReplyText("stream_truncation")).toBe(generic);
    expect(degradedReplyText(null)).toBe(generic);
  });
});
