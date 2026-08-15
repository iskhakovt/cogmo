import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { ProviderProtocolError } from "../llm/errors.js";
import { RefusalError } from "../llm/fallback.js";
import type { LlmProvider } from "../llm/provider.js";
import type { LlmResponse, Message, ToolUseBlock } from "../llm/types.js";
import {
  CLASS_D_CONSECUTIVE_LIMIT,
  CLASS_D_CUMULATIVE_LIMIT,
  classifyClassDTrip,
  classifyPostStream,
  classifyStreamError,
  classifyVolumeCluster,
  computeIterationFingerprint,
  degradedReplyText,
  formatVolumeClusterContent,
  freshBudgets,
  INITIAL_BUDGETS,
  type RepairBudgets,
  summarizeToolHistory,
  synthesizeDegradedReply,
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

  // RFC 8785 rejects lone surrogates and `canonicalize` throws on them. Tool
  // args are model output, so that has to degrade rather than abort the turn —
  // the call site in the agent loop treats a throw here as fatal.
  it("hashes args containing a lone surrogate instead of throwing", () => {
    const loneHigh = computeIterationFingerprint([toolUse("t1", "search", { q: "bad\uD800end" })]);
    const loneLow = computeIterationFingerprint([toolUse("t2", "search", { q: "bad\uDC00end" })]);
    expect(loneHigh).not.toBeNull();
    expect(loneLow).not.toBeNull();
  });

  it("hashes a lone surrogate in an object key instead of throwing", () => {
    expect(
      computeIterationFingerprint([toolUse("t1", "search", { "k\uD800": "v" })]),
    ).not.toBeNull();
  });

  it("stays deterministic for a lone surrogate — equal args still hash equal", () => {
    const a = computeIterationFingerprint([toolUse("t1", "search", { q: "x\uD800y" })]);
    const b = computeIterationFingerprint([toolUse("t2", "search", { q: "x\uD800y" })]);
    expect(a).toBe(b);
  });

  it("leaves well-formed surrogate pairs alone — emoji args stay distinct", () => {
    const a = computeIterationFingerprint([toolUse("t1", "search", { q: "😀" })]);
    const b = computeIterationFingerprint([toolUse("t2", "search", { q: "🎉" })]);
    expect(a).not.toBe(b);
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

describe("summarizeToolHistory", () => {
  function assistantToolUses(...blocks: ToolUseBlock[]): Message {
    return { role: "assistant", content: blocks };
  }

  function pair(id: string, name: string, isError: boolean, content: string): Message[] {
    return [
      assistantToolUses({ type: "tool_use", id, name, input: {} }),
      {
        role: "user",
        content: [
          isError
            ? { type: "tool_result", toolUseId: id, content, isError: true }
            : { type: "tool_result", toolUseId: id, content },
        ],
      },
    ];
  }

  it("returns an empty map when no tool_use blocks appear in the slice", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    expect(summarizeToolHistory(messages, 0).size).toBe(0);
  });

  // callCount = total tool_use blocks for the tool in the slice.
  it("counts tool_use blocks across multiple assistant messages from fromIdx", () => {
    const messages: Message[] = [
      { role: "user", content: "ignored before fromIdx" },
      assistantToolUses({ type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } }),
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }] },
      assistantToolUses({ type: "tool_use", id: "t2", name: "read_file", input: { path: "b" } }),
      assistantToolUses({ type: "tool_use", id: "t3", name: "web_search", input: { q: "x" } }),
      assistantToolUses({ type: "tool_use", id: "t4", name: "read_file", input: { path: "c" } }),
    ];
    const history = summarizeToolHistory(messages, 0);
    expect(history.get("read_file")?.callCount).toBe(3);
    expect(history.get("web_search")?.callCount).toBe(1);
  });

  it("ignores messages before fromIdx (turn-boundary scope)", () => {
    const messages: Message[] = [
      assistantToolUses({ type: "tool_use", id: "old1", name: "read_file", input: { path: "x" } }),
      assistantToolUses({ type: "tool_use", id: "old2", name: "read_file", input: { path: "y" } }),
      assistantToolUses({ type: "tool_use", id: "new1", name: "read_file", input: { path: "z" } }),
    ];
    expect(summarizeToolHistory(messages, 2).get("read_file")?.callCount).toBe(1);
  });

  it("counts multiple tool_use blocks within a single assistant message", () => {
    const messages: Message[] = [
      assistantToolUses(
        { type: "tool_use", id: "a", name: "read_file", input: { path: "1" } },
        { type: "tool_use", id: "b", name: "read_file", input: { path: "2" } },
        { type: "tool_use", id: "c", name: "read_file", input: { path: "3" } },
      ),
    ];
    expect(summarizeToolHistory(messages, 0).get("read_file")?.callCount).toBe(3);
  });

  it("ignores string-content messages and non-assistant messages for tool_use counting", () => {
    const messages: Message[] = [
      { role: "user", content: "tool_use is a tool_use" },
      { role: "assistant", content: "string-typed content with the word tool_use" },
      assistantToolUses({ type: "tool_use", id: "real", name: "read_file", input: {} }),
    ];
    expect(summarizeToolHistory(messages, 0).get("read_file")?.callCount).toBe(1);
  });

  // priorBatchCount = distinct prior iterations (excludes the last
  // assistant message in the slice — the "current" iteration).
  it("priorBatchCount counts distinct prior iterations, not blocks", () => {
    const messages: Message[] = [
      // Two prior iterations, the first with 3 parallel blocks.
      assistantToolUses(
        { type: "tool_use", id: "a1", name: "read_file", input: {} },
        { type: "tool_use", id: "a2", name: "read_file", input: {} },
        { type: "tool_use", id: "a3", name: "read_file", input: {} },
      ),
      assistantToolUses({ type: "tool_use", id: "b1", name: "read_file", input: {} }),
      // The current (last) iteration.
      assistantToolUses({ type: "tool_use", id: "c1", name: "read_file", input: {} }),
    ];
    const summary = summarizeToolHistory(messages, 0).get("read_file");
    expect(summary?.callCount).toBe(5);
    // 2 prior iterations contributed to the batch counter — the last one
    // is the current iteration and is excluded.
    expect(summary?.priorBatchCount).toBe(2);
  });

  // When the slice's last message is a user `tool_result` (no current
  // iteration pending), no exclusion fires and `priorBatchCount` equals
  // the total distinct same-tool batches. Pins the documented contract
  // for callers that aren't the volume-cluster trigger.
  it("priorBatchCount equals total batches when the last message is a user tool_result", () => {
    const messages: Message[] = [
      ...pair("a", "img", false, "ok"),
      ...pair("b", "img", false, "ok"),
      ...pair("c", "img", false, "ok"),
    ];
    const summary = summarizeToolHistory(messages, 0).get("img");
    expect(summary?.callCount).toBe(3);
    // Last msg is the user tool_result for "c". No assistant batch is at
    // that index, so nothing is excluded — all 3 batches count.
    expect(summary?.priorBatchCount).toBe(3);
  });

  it("priorBatchCount excludes the last assistant message regardless of how many blocks it carries", () => {
    const messages: Message[] = [
      assistantToolUses({ type: "tool_use", id: "p", name: "x", input: {} }),
      assistantToolUses(
        { type: "tool_use", id: "c1", name: "x", input: {} },
        { type: "tool_use", id: "c2", name: "x", input: {} },
        { type: "tool_use", id: "c3", name: "x", input: {} },
      ),
    ];
    const summary = summarizeToolHistory(messages, 0).get("x");
    expect(summary?.callCount).toBe(4);
    expect(summary?.priorBatchCount).toBe(1);
  });

  // outcomes — pairing tool_results by toolUseId, classifying by isError.
  it("outcomes count successes and failures by inspecting tool_result.isError", () => {
    const messages: Message[] = [
      ...pair("t1", "read_file", false, "data1"),
      ...pair("t2", "read_file", true, "Error: ENOENT no such file"),
      ...pair("t3", "read_file", false, "data2"),
      ...pair("t4", "read_file", true, "Error: permission denied"),
    ];
    const summary = summarizeToolHistory(messages, 0).get("read_file");
    expect(summary?.outcomes.successes).toBe(2);
    expect(summary?.outcomes.failures).toBe(2);
    expect(summary?.outcomes.failureReasons).toEqual([
      "Error: ENOENT no such file",
      "Error: permission denied",
    ]);
  });

  it("outcomes dedupe identical failure reasons", () => {
    const messages: Message[] = [
      ...pair("t1", "generate_image", true, "image was flagged as nsfw"),
      ...pair("t2", "generate_image", true, "image was flagged as nsfw"),
      ...pair("t3", "generate_image", true, "image was flagged as nsfw"),
    ];
    const summary = summarizeToolHistory(messages, 0).get("generate_image");
    expect(summary?.outcomes.failureReasons).toEqual(["image was flagged as nsfw"]);
    expect(summary?.outcomes.failures).toBe(3);
  });

  it("outcomes only count tool_results whose toolUseId pairs to a same-name tool_use", () => {
    // The web_search failure must not contaminate the read_file outcomes.
    const messages: Message[] = [
      ...pair("a", "read_file", false, "ok"),
      ...pair("b", "web_search", true, "rate limited"),
    ];
    const read = summarizeToolHistory(messages, 0).get("read_file");
    expect(read?.outcomes.successes).toBe(1);
    expect(read?.outcomes.failures).toBe(0);
  });

  it("outcomes exclude this tool's own prior volume-cluster nudges (recursive-impurity invariant)", () => {
    // Pin the recursive-impurity fix: if the model ignored a previous
    // nudge and emitted another batch, summarizeToolHistory runs against
    // a history that already contains the synthetic intercept. Without
    // the prefix filter, that synthetic would be counted as a failure
    // and its first line quoted back as a "reason" in the next nudge.
    const messages: Message[] = [
      ...pair("t1", "img", true, "Error: nsfw flagged"),
      ...pair("t2", "img", true, "Error: nsfw flagged"),
      // Synthetic from a prior intercept — matches the all-success branch
      // of formatVolumeClusterContent ("You have called `img` 3 times
      // this turn — 2 succeeded. Do NOT call `img` again...").
      ...pair(
        "t3",
        "img",
        true,
        "You have called `img` 3 times this turn — 2 succeeded. " +
          "Do NOT call `img` again this turn. Either reply to the user with what you have, " +
          "ask a clarifying question, or use a different tool.",
      ),
      ...pair("t4", "img", true, "Error: too long"),
    ];
    const summary = summarizeToolHistory(messages, 0).get("img");
    // 3 real failures (t1, t2, t4); the synthetic t3 is excluded.
    expect(summary?.outcomes.failures).toBe(3);
    expect(summary?.outcomes.successes).toBe(0);
    expect(summary?.outcomes.failureReasons).toEqual(["Error: nsfw flagged", "Error: too long"]);
    // Negative assertion: no reason starts with the prefix.
    for (const reason of summary?.outcomes.failureReasons ?? []) {
      expect(reason.startsWith("You have called `img`")).toBe(false);
    }
  });

  it("returns separate entries per tool name in one pass", () => {
    // The whole point of the consolidated helper: a single scan
    // produces every tool's summary, not one-scan-per-tool.
    const messages: Message[] = [
      ...pair("r1", "read_file", false, "data"),
      ...pair("w1", "web_search", true, "timeout"),
      ...pair("r2", "read_file", true, "Error"),
    ];
    const history = summarizeToolHistory(messages, 0);
    expect(history.get("read_file")?.callCount).toBe(2);
    expect(history.get("read_file")?.outcomes.failures).toBe(1);
    expect(history.get("web_search")?.callCount).toBe(1);
    expect(history.get("web_search")?.outcomes.failures).toBe(1);
  });
});

describe("formatVolumeClusterContent", () => {
  it("all-failure phrasing names the failure count and reasons", () => {
    const content = formatVolumeClusterContent("generate_image", 3, {
      successes: 0,
      failures: 2,
      failureReasons: ["nsfw flagged", "prompt too long"],
    });
    expect(content).toMatch(/3 times.*every attempt failed/i);
    expect(content).toContain("nsfw flagged");
    expect(content).toContain("prompt too long");
    expect(content).toMatch(/Do NOT call `generate_image` again/);
  });

  it("all-success phrasing names the success count and tells the model to synthesize", () => {
    const content = formatVolumeClusterContent("web_search", 6, {
      successes: 5,
      failures: 0,
      failureReasons: [],
    });
    expect(content).toMatch(/6 times.*5 succeeded/i);
    expect(content).not.toMatch(/failed/i);
    expect(content).toMatch(/Do NOT call `web_search` again/);
  });

  it("mixed phrasing names both counts and includes failure reasons", () => {
    const content = formatVolumeClusterContent("read_file", 11, {
      successes: 7,
      failures: 3,
      failureReasons: ["not found"],
    });
    expect(content).toMatch(/11 times.*7 succeeded, 3 failed/i);
    expect(content).toContain("not found");
    expect(content).toMatch(/Do NOT call `read_file` again/);
  });
});

describe("classifyVolumeCluster", () => {
  it("returns null when count is at or below budget", () => {
    expect(classifyVolumeCluster(1, 5)).toBeNull();
    expect(classifyVolumeCluster(5, 5)).toBeNull();
  });

  it("returns intercept verdict when count exceeds budget", () => {
    expect(classifyVolumeCluster(6, 5)).toEqual({ kind: "intercept", count: 6 });
    expect(classifyVolumeCluster(3, 2)).toEqual({ kind: "intercept", count: 3 });
  });

  it("budget = 2 admits 2 calls, intercepts the 3rd onward", () => {
    expect(classifyVolumeCluster(1, 2)).toBeNull();
    expect(classifyVolumeCluster(2, 2)).toBeNull();
    expect(classifyVolumeCluster(3, 2)).not.toBeNull();
    expect(classifyVolumeCluster(4, 2)).not.toBeNull();
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

describe("synthesizeDegradedReply", () => {
  function fakeLogger(): Logger {
    return mock<Logger>();
  }

  function textResponse(text: string, usage = { inputTokens: 100, outputTokens: 20 }): LlmResponse {
    return {
      content: [{ type: "text", text }],
      stopReason: "end_turn",
      model: "test-model",
      usage,
    };
  }

  function providerThat(chat: () => Promise<LlmResponse>): LlmProvider {
    return {
      name: "synth-test",
      chat: vi.fn(chat),
      chatStream: vi.fn(),
      countTokens: vi.fn(),
    };
  }

  const baseDeps = () => ({
    model: "test-model",
    messages: [
      { role: "user" as const, content: "draw me a picture" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "trying..." }] },
    ],
    reason: "stuck_loop",
    subtype: "stuck_loop" as const,
    log: fakeLogger(),
  });

  it("returns synthesized text + ok: true when the provider returns usable text", async () => {
    const provider = providerThat(async () =>
      textResponse(
        "I tried generating an image three times but each attempt was flagged. Try rephrasing the prompt to be more descriptive.",
      ),
    );
    const result = await synthesizeDegradedReply({ ...baseDeps(), provider });
    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/three times/);
  });

  it("uses tools-disabled at the API level and temperature: 0", async () => {
    const chatFn = vi.fn<LlmProvider["chat"]>(async () => textResponse("ok"));
    const provider: LlmProvider = {
      name: "synth-test",
      chat: chatFn,
      chatStream: vi.fn(),
      countTokens: vi.fn(),
    };
    await synthesizeDegradedReply({ ...baseDeps(), provider });
    expect(chatFn).toHaveBeenCalledTimes(1);
    const callArgs = chatFn.mock.calls[0]?.[0];
    expect(callArgs?.tools).toEqual([]);
    expect(callArgs?.temperature).toBe(0);
  });

  it("falls back to the fixed string when the chat call rejects with an error", async () => {
    const provider = providerThat(async () => {
      throw new Error("provider down");
    });
    const result = await synthesizeDegradedReply({ ...baseDeps(), provider });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/trouble generating/i);
  });

  it("falls back when the chat call refuses (RefusalError)", async () => {
    const provider = providerThat(async () => {
      throw new RefusalError("model refused synthesis");
    });
    const result = await synthesizeDegradedReply({
      ...baseDeps(),
      subtype: "stuck_loop",
      provider,
    });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/trouble generating/i);
  });

  it("uses the refusal-specific fixed string when subtype is refusal and synthesis fails", async () => {
    const provider = providerThat(async () => {
      throw new Error("boom");
    });
    const result = await synthesizeDegradedReply({
      ...baseDeps(),
      subtype: "refusal",
      reason: "model returned a policy refusal",
      provider,
    });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/declined/i);
  });

  it("falls back on wall-clock timeout — does not extend the user's wait", async () => {
    // Provider that never resolves; the race must abort.
    const provider = providerThat(() => new Promise<LlmResponse>(() => {}));
    const result = await synthesizeDegradedReply({
      ...baseDeps(),
      provider,
      timeoutMs: 25,
    });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/trouble generating/i);
  });

  it("falls back when the chat call returns empty text content", async () => {
    const provider = providerThat(async () => textResponse("   "));
    const result = await synthesizeDegradedReply({ ...baseDeps(), provider });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/trouble generating/i);
  });

  it("emits agent.degrade.synthesis telemetry with ok and token counts on success", async () => {
    const log = fakeLogger();
    const provider = providerThat(async () =>
      textResponse("done", { inputTokens: 250, outputTokens: 18 }),
    );
    await synthesizeDegradedReply({ ...baseDeps(), provider, log });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.degrade.synthesis",
        subtype: "stuck_loop",
        ok: true,
        tokensIn: 250,
        tokensOut: 18,
      }),
      expect.any(String),
    );
  });

  it("emits agent.degrade.synthesis telemetry with ok: false on failure", async () => {
    const log = fakeLogger();
    const provider = providerThat(async () => {
      throw new Error("upstream 500");
    });
    await synthesizeDegradedReply({ ...baseDeps(), provider, log });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.degrade.synthesis",
        subtype: "stuck_loop",
        ok: false,
        fallback: "error",
      }),
      expect.any(String),
    );
  });

  it("tags the fallback reason as 'protocol' on a ProviderProtocolError", async () => {
    // Unreachable in practice with `tools: []` (no streamed tool-arg
    // JSON to fail parsing), but the telemetry contract maps the error
    // class to this tag, so pin it.
    const log = fakeLogger();
    const provider = providerThat(async () => {
      throw new ProviderProtocolError("malformed tool-arg JSON", new SyntaxError("x"));
    });
    await synthesizeDegradedReply({ ...baseDeps(), provider, log });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.degrade.synthesis",
        ok: false,
        fallback: "protocol",
      }),
      expect.any(String),
    );
  });

  it("tags the fallback reason as 'timeout' when the timeout wins", async () => {
    const log = fakeLogger();
    const provider = providerThat(() => new Promise<LlmResponse>(() => {}));
    await synthesizeDegradedReply({ ...baseDeps(), provider, log, timeoutMs: 25 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.degrade.synthesis",
        ok: false,
        fallback: "timeout",
      }),
      expect.any(String),
    );
  });

  it("clears the timeout timer on the success path — no dangling setTimeout", async () => {
    vi.useFakeTimers();
    try {
      const provider = providerThat(async () => textResponse("ok"));
      const result = await synthesizeDegradedReply({ ...baseDeps(), provider, timeoutMs: 5000 });
      expect(result.ok).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not throw on any failure path — degrade-the-degrade is forbidden", async () => {
    // The orchestrator treats this call as best-effort; throwing here
    // would propagate up and fail the whole turn after the loop already
    // decided to degrade gracefully.
    const failingProvider = providerThat(async () => {
      throw new Error("anything");
    });
    await expect(
      synthesizeDegradedReply({ ...baseDeps(), provider: failingProvider }),
    ).resolves.toEqual(expect.objectContaining({ ok: false }));
  });

  it("renders subtype-specific reason text in the system prompt", async () => {
    const chatFn = vi.fn<LlmProvider["chat"]>(async () => textResponse("ok"));
    const provider: LlmProvider = {
      name: "synth-test",
      chat: chatFn,
      chatStream: vi.fn(),
      countTokens: vi.fn(),
    };
    await synthesizeDegradedReply({
      ...baseDeps(),
      subtype: "stream_truncation",
      reason: "streamed tool-call arguments could not be parsed",
      provider,
    });
    const systemPrompt = chatFn.mock.calls[0]?.[0]?.system ?? "";
    expect(systemPrompt).toMatch(/truncated/i);
  });

  it("renders the iteration-cap reason text for null subtype + iteration_cap reason", async () => {
    const chatFn = vi.fn<LlmProvider["chat"]>(async () => textResponse("ok"));
    const provider: LlmProvider = {
      name: "synth-test",
      chat: chatFn,
      chatStream: vi.fn(),
      countTokens: vi.fn(),
    };
    await synthesizeDegradedReply({
      ...baseDeps(),
      subtype: null,
      reason: "iteration_cap",
      provider,
    });
    const systemPrompt = chatFn.mock.calls[0]?.[0]?.system ?? "";
    expect(systemPrompt).toMatch(/iteration-count limit/i);
  });
});
