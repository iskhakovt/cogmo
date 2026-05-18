import { describe, expect, it } from "vitest";
import { ProviderProtocolError } from "../llm/errors.js";
import { RefusalError } from "../llm/fallback.js";
import type { ToolUseBlock } from "../llm/types.js";
import {
  CLASS_D_CONSECUTIVE_LIMIT,
  CLASS_D_CUMULATIVE_LIMIT,
  classifyClassDTrip,
  classifyPostStream,
  classifyStreamError,
  computeIterationFingerprint,
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

describe("computeIterationFingerprint", () => {
  function toolUse(id: string, name: string, input: unknown): ToolUseBlock {
    return { type: "tool_use", id, name, input };
  }

  it("returns null when there are no tool calls", () => {
    expect(computeIterationFingerprint([])).toBeNull();
  });

  it("produces identical hashes for identical (name, args) sequences", () => {
    const a = computeIterationFingerprint([toolUse("a1", "read_file", { path: "x" })]);
    const b = computeIterationFingerprint([toolUse("b2", "read_file", { path: "x" })]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("ignores emission order — sort-stable across parallel-tool reorderings", () => {
    const a = computeIterationFingerprint([
      toolUse("t1", "search", { q: "foo" }),
      toolUse("t2", "fetch", { url: "https://x" }),
    ]);
    const b = computeIterationFingerprint([
      toolUse("t3", "fetch", { url: "https://x" }),
      toolUse("t4", "search", { q: "foo" }),
    ]);
    expect(a).toBe(b);
  });

  it("ignores object-key order in args (canonical JSON)", () => {
    const a = computeIterationFingerprint([toolUse("t1", "read_file", { path: "x", mode: "r" })]);
    const b = computeIterationFingerprint([toolUse("t2", "read_file", { mode: "r", path: "x" })]);
    expect(a).toBe(b);
  });

  it("discriminates on args — different paths produce different hashes", () => {
    const a = computeIterationFingerprint([toolUse("t1", "read_file", { path: "a.txt" })]);
    const b = computeIterationFingerprint([toolUse("t2", "read_file", { path: "b.txt" })]);
    const c = computeIterationFingerprint([toolUse("t3", "read_file", { path: "c.txt" })]);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("discriminates on tool name with identical args", () => {
    const a = computeIterationFingerprint([toolUse("t1", "read_file", { path: "x" })]);
    const b = computeIterationFingerprint([toolUse("t2", "list_files", { path: "x" })]);
    expect(a).not.toBe(b);
  });

  it("ignores tool_use.id (per-call random IDs do not move the hash)", () => {
    const a = computeIterationFingerprint([toolUse("ID-A", "read_file", { path: "x" })]);
    const b = computeIterationFingerprint([toolUse("ID-Z", "read_file", { path: "x" })]);
    expect(a).toBe(b);
  });
});

describe("classifyClassDTrip", () => {
  it("returns null below both thresholds", () => {
    expect(classifyClassDTrip(1, 1)).toBeNull();
    expect(
      classifyClassDTrip(CLASS_D_CONSECUTIVE_LIMIT - 1, CLASS_D_CUMULATIVE_LIMIT - 1),
    ).toBeNull();
  });

  it("returns stuck_loop when the consecutive threshold is reached", () => {
    expect(classifyClassDTrip(CLASS_D_CONSECUTIVE_LIMIT, CLASS_D_CONSECUTIVE_LIMIT)).toBe(
      "stuck_loop",
    );
  });

  it("returns stuck_loop_cumulative when only the cumulative threshold is reached", () => {
    // Consecutive count stays under the limit (e.g. alternating pattern
    // never builds three in a row) but cumulative reaches the cap.
    expect(classifyClassDTrip(1, CLASS_D_CUMULATIVE_LIMIT)).toBe("stuck_loop_cumulative");
  });

  it("prefers stuck_loop over stuck_loop_cumulative when both fire", () => {
    // The tighter trigger wins — three in a row also accumulates three
    // total, but the subtype tag distinguishes the failure shape.
    expect(classifyClassDTrip(CLASS_D_CONSECUTIVE_LIMIT, CLASS_D_CUMULATIVE_LIMIT)).toBe(
      "stuck_loop",
    );
  });
});

describe("degradedReplyText", () => {
  it("returns the refusal-specific message for the refusal subtype", () => {
    expect(degradedReplyText("refusal")).toMatch(/declined/i);
  });

  it("returns the generic apology for empty_end_turn / stream_truncation / stuck_loop / null", () => {
    const generic = degradedReplyText("empty_end_turn");
    expect(generic).toMatch(/trouble generating/i);
    expect(degradedReplyText("stream_truncation")).toBe(generic);
    expect(degradedReplyText("stuck_loop")).toBe(generic);
    expect(degradedReplyText("stuck_loop_cumulative")).toBe(generic);
    expect(degradedReplyText(null)).toBe(generic);
  });
});
