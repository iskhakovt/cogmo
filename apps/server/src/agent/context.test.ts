import { describe, expect, it, vi } from "vitest";
import type { ContentBlock, Message, ToolResultClearing } from "../llm/types.js";
import { expectDefined } from "../test/assertions.js";
import {
  type ContextManagerDeps,
  compactMessages,
  extractSummaryText,
  SUMMARIZATION_PROMPT,
  shouldSkipCounting,
  snapToPairBoundary,
  summarizationRequest,
  toolResultClearing,
} from "./context.js";

/** Strategy 1's intent at a budget of 1,000 tokens. */
const CLEARING: ToolResultClearing = { triggerTokens: 600, keep: 5, clearAtLeastTokens: 100 };

/** Helper: create a simple text message. */
function msg(role: "user" | "assistant", text: string): Message {
  return { role, content: text };
}

/** Helper: create a user message with tool results. */
function toolResultMsg(results: Array<{ id: string; content: string }>): Message {
  return {
    role: "user",
    content: results.map((r) => ({
      type: "tool_result" as const,
      toolUseId: r.id,
      content: r.content,
    })),
  };
}

/** Helper: create an assistant message with a tool call. */
function toolCallMsg(id: string, name: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  };
}

describe("compactMessages", () => {
  it("passes messages through unchanged when under budget", async () => {
    const messages = [msg("user", "hello"), msg("assistant", "hi")];
    const result = await compactMessages("system", messages, undefined, {
      countTokens: vi.fn().mockResolvedValue(100),
      budget: 1000,
      clearToolResults: CLEARING,
    });

    expect(result.didCompact).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.event).toBeUndefined();
  });

  it("counts with Strategy 1's intent and leaves every tool result as it is", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 7; i++) {
      messages.push(msg("user", `query ${i}`));
      messages.push(toolCallMsg(`t${i}`, `search_${i}`));
      messages.push(toolResultMsg([{ id: `t${i}`, content: `result-${i}-${"x".repeat(1000)}` }]));
      messages.push(msg("assistant", `answer ${i}`));
    }
    const before = structuredClone(messages);
    // Past the clearing threshold, under the summarization one.
    const countTokens = vi.fn().mockResolvedValue(700);

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      summarize: vi.fn(),
    });

    expect(result.didCompact).toBe(false);
    expect(result.messages).toEqual(before);
    expect(countTokens).toHaveBeenCalledOnce();
    expect(countTokens).toHaveBeenCalledWith(
      expect.objectContaining({ messages: before, clearToolResults: CLEARING }),
    );
  });

  it("carries the intent on every count, after a summary and a truncation too", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(msg("user", `q${i}`));
      messages.push(msg("assistant", `a${i}`));
    }
    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(980)
      .mockResolvedValueOnce(960)
      .mockResolvedValueOnce(200);

    await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      summarize: vi.fn().mockResolvedValue("a summary"),
    });

    expect(countTokens).toHaveBeenCalledTimes(3);
    for (const [params] of countTokens.mock.calls) {
      expect(params.clearToolResults).toEqual(CLEARING);
    }
  });

  it("does not summarize when the count after clearing is under 80%", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 7; i++) {
      messages.push(msg("user", `q${i}`));
      messages.push(toolCallMsg(`t${i}`, "search"));
      messages.push(toolResultMsg([{ id: `t${i}`, content: "x".repeat(1000) }]));
      messages.push(msg("assistant", `a${i}`));
    }

    // Over 60%, which the intent clears, and under 80%.
    const countTokens = vi.fn().mockResolvedValueOnce(700);
    const summarize = vi.fn();

    await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      summarize,
    });

    expect(summarize).not.toHaveBeenCalled();
  });

  it("summarizes conversation prefix at 80% threshold", async () => {
    const messages = [
      msg("user", "old message 1"),
      msg("assistant", "old reply 1"),
      msg("user", "old message 2"),
      msg("assistant", "old reply 2"),
      msg("user", "old message 3"),
      msg("assistant", "old reply 3"),
      msg("user", "old message 4"),
      msg("assistant", "old reply 4"),
      msg("user", "recent question"),
      msg("assistant", "recent answer"),
      msg("user", "latest question"),
      msg("assistant", "latest answer"),
    ];

    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(900) // after clearing: over 80%
      .mockResolvedValueOnce(300); // after summarization: under
    const summarize = vi.fn().mockResolvedValue("Summary of old messages");

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      summarize,
    });

    expect(result.didCompact).toBe(true);
    expect(result.event?.strategies).toEqual(["summarize"]);
    expect(summarize).toHaveBeenCalledOnce();

    // Should keep last 6 messages, summarize the rest
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content).toContain("[Previous conversation summary]");
    expect(result.messages[0]?.content).toContain("Summary of old messages");
    // 1 summary + 6 kept = 7 messages
    expect(result.messages).toHaveLength(7);
  });

  // Locks the contract documented on `ContextManagerDeps.summarize`. The
  // hardcoded `summarize-prefix-outcome` step ID in `handle-message.ts` depends on
  // this — Inngest throws on duplicate step IDs, so a future change that
  // calls `summarize` twice (e.g., segmented summarization) would surface
  // only at runtime under specific conversation lengths. This test catches
  // it at unit-test time.
  it("calls summarize at most once even when both rewriting strategies fire", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(msg("user", `q${i}`));
      messages.push(toolCallMsg(`t${i}`, `search_${i}`));
      messages.push(toolResultMsg([{ id: `t${i}`, content: "x".repeat(500) }]));
      messages.push(msg("assistant", `a${i}`));
    }

    // Stay above the 95% truncate threshold through summarization so both
    // fire in sequence: summarize → truncate.
    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(980) // initial: over 95%
      .mockResolvedValueOnce(960) // after summarization: still over 95%
      .mockResolvedValueOnce(200); // after truncation: under
    const summarize = vi.fn().mockResolvedValue("Summary of old messages");

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      summarize,
    });

    expect(result.event?.strategies).toEqual(["summarize", "truncate"]);
    expect(summarize).toHaveBeenCalledOnce();
  });

  it("falls through to truncation when summarization fails", async () => {
    const messages = [
      msg("user", "m1"),
      msg("assistant", "r1"),
      msg("user", "m2"),
      msg("assistant", "r2"),
      msg("user", "m3"),
      msg("assistant", "r3"),
      msg("user", "m4"),
      msg("assistant", "r4"),
      msg("user", "m5"),
      msg("assistant", "r5"),
    ];

    // Over 95% throughout — summarize fails, falls through to truncation
    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(980) // initial
      .mockResolvedValueOnce(500); // after truncation
    const summarize = vi.fn().mockRejectedValue(new Error("LLM timeout"));

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      summarize,
    });

    expect(result.event?.strategies).toContain("truncate");
    expect(result.event?.strategies).not.toContain("summarize");
  });

  it("truncation preserves alternation — inserts synthetic user message", async () => {
    const messages = [
      msg("user", "old1"),
      msg("assistant", "old2"),
      msg("assistant", "remaining"), // would be first after truncation
      msg("user", "latest"),
    ];

    // Over 95%
    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(960) // initial
      .mockResolvedValueOnce(400); // after truncation

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
    });

    expect(result.didCompact).toBe(true);
    // If first remaining is assistant, synthetic user message is prepended
    const first = result.messages[0];
    if (first?.role === "user") {
      expect(
        first.content === "[Earlier conversation history was truncated]" ||
          first.content === "latest",
      ).toBe(true);
    }
  });

  it("keeps the prefix when the summarizer returns no text", async () => {
    // The summary is substituted for the whole prefix, so an empty one
    // would leave a bare `[Previous conversation summary]` header standing
    // in for that span of the conversation. Reachable whenever the
    // summarization model spends its output budget on reasoning.
    const messages: Message[] = [
      msg("user", "m1"),
      msg("assistant", "r1"),
      msg("user", "m2"),
      msg("assistant", "r2"),
      msg("user", "m3"),
      msg("assistant", "r3"),
      msg("user", "m4"),
      msg("assistant", "r4"),
    ];

    const countTokens = vi.fn().mockResolvedValue(850);

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      summarize: vi.fn().mockResolvedValue("   "),
    });

    expect(
      result.messages.some((m) => String(m.content).includes("Previous conversation summary")),
    ).toBe(false);
    expect(result.event?.messagesSummarized ?? 0).toBe(0);
  });

  it("reports correct CompactionEvent stats", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(msg("user", `q${i}`));
      messages.push(toolCallMsg(`t${i}`, `search_${i}`));
      messages.push(toolResultMsg([{ id: `t${i}`, content: "x".repeat(1000) }]));
      messages.push(msg("assistant", `a${i}`));
    }

    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(900) // after clearing: over 80%
      .mockResolvedValueOnce(400); // after summarization: under

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      summarize: vi.fn().mockResolvedValue("summary"),
    });

    expect(result.event).toEqual({
      strategies: ["summarize"],
      tokensBefore: 900,
      tokensAfter: 400,
      // 32 messages, six kept: the split at 26 lands on a tool result and snaps back to its call.
      messagesSummarized: 25,
    });
  });

  it("leaves a same-tool cluster verbatim, on the fast path and off it", async () => {
    // Five `web_search` results: no rung of compaction rewrites a same-tool cluster.
    const messages: Message[] = ["alpha", "beta", "gamma", "delta", "epsilon"].flatMap(
      (q, i): Message[] => [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: `t${i}`, name: "web_search", input: { query: q } }],
        },
        toolResultMsg([{ id: `t${i}`, content: `body-of-${q}-${"·".repeat(500)}` }]),
      ],
    );
    const before = structuredClone(messages);

    for (const skip of [true, false]) {
      const result = await compactMessages(
        "system",
        messages,
        undefined,
        { countTokens: vi.fn().mockResolvedValue(100), budget: 1000, clearToolResults: CLEARING },
        skip,
      );

      expect(result.didCompact).toBe(false);
      expect(result.messages).toEqual(before);
    }
  });

  it("does not call countTokens when skipBudgetStrategies is set", async () => {
    const countTokens = vi.fn().mockResolvedValue(100);
    const result = await compactMessages(
      "system",
      [msg("user", "hello"), msg("assistant", "hi")],
      undefined,
      { countTokens, budget: 1000, clearToolResults: CLEARING },
      true,
    );

    expect(result.didCompact).toBe(false);
    expect(countTokens).not.toHaveBeenCalled();
  });
});

describe("toolResultClearing", () => {
  it("clears past 60% of the budget, keeps five results, and frees at least a tenth", () => {
    expect(toolResultClearing(200_000)).toEqual({
      triggerTokens: 120_000,
      keep: 5,
      clearAtLeastTokens: 20_000,
    });
  });
});

describe("snapToPairBoundary", () => {
  it("returns splitIdx unchanged when suffix starts with a text user message", () => {
    const messages: Message[] = [
      msg("user", "old"),
      msg("assistant", "old reply"),
      msg("user", "recent"),
      msg("assistant", "recent reply"),
    ];
    expect(snapToPairBoundary(messages, 2)).toBe(2);
  });

  it("snaps backward when suffix starts with orphaned tool_result", () => {
    const messages: Message[] = [
      msg("user", "question"),
      toolCallMsg("t1", "search"),
      toolResultMsg([{ id: "t1", content: "result" }]),
      msg("assistant", "final answer"),
    ];
    // Cutting at index 2 would orphan tool_result — snap back to 1 (the assistant with tool_use)
    expect(snapToPairBoundary(messages, 2)).toBe(1);
  });

  it("snaps past multiple consecutive tool rounds", () => {
    const messages: Message[] = [
      msg("user", "start"),
      toolCallMsg("t1", "search"), // 1: assistant
      toolResultMsg([{ id: "t1", content: "r1" }]), // 2: user (tool_result)
      toolCallMsg("t2", "fetch"), // 3: assistant (second tool call)
      toolResultMsg([{ id: "t2", content: "r2" }]), // 4: user (tool_result)
      msg("assistant", "done"), // 5
    ];
    // Cutting at 4 → snaps to 3, then 3 is assistant (no tool_result) → stop at 3
    expect(snapToPairBoundary(messages, 4)).toBe(3);
    // Cutting at 2 → snaps to 1
    expect(snapToPairBoundary(messages, 2)).toBe(1);
  });

  it("returns 0 when all messages are tool rounds", () => {
    const messages: Message[] = [
      toolCallMsg("t1", "search"),
      toolResultMsg([{ id: "t1", content: "r1" }]),
      toolCallMsg("t2", "fetch"),
      toolResultMsg([{ id: "t2", content: "r2" }]),
    ];
    // Cutting at 1 → user with tool_result → snap to 0 (assistant, stops because idx=0)
    expect(snapToPairBoundary(messages, 1)).toBe(0);
    // Cutting at 3 → snap to 2 (assistant with tool_use, no tool_result)
    expect(snapToPairBoundary(messages, 3)).toBe(2);
  });

  it("handles splitIdx at array boundaries", () => {
    const messages: Message[] = [msg("user", "hi"), msg("assistant", "hey")];
    expect(snapToPairBoundary(messages, 0)).toBe(0);
    expect(snapToPairBoundary(messages, 2)).toBe(2);
  });
});

/** Assert no message in the array has a tool_result without a matching tool_use in the preceding assistant. */
function assertNoOrphanedToolResults(messages: ReadonlyArray<Message>): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (typeof m.content !== "string" && m.content.some((b) => b.type === "tool_result")) {
      expect(i).toBeGreaterThan(0);
      const prev = messages[i - 1]!;
      expect(prev.role).toBe("assistant");
      expect(typeof prev.content).not.toBe("string");
      const toolUseIds = (prev.content as ContentBlock[])
        .filter((b) => b.type === "tool_use")
        .map((b) => b.id);
      const toolResultIds = (m.content as ContentBlock[])
        .filter((b) => b.type === "tool_result")
        .map((b) => b.toolUseId);
      for (const id of toolResultIds) {
        expect(toolUseIds).toContain(id);
      }
    }
  }
}

describe("compactMessages — pair-aware", () => {
  it("truncation never orphans a tool_use/tool_result pair", async () => {
    // 13 messages → 30% = 3.9 → ceil = 4 → naïve cut at index 4 (a tool_result user message)
    const msgs13: Message[] = [
      msg("user", "a"),
      msg("assistant", "b"),
      msg("user", "c"),
      toolCallMsg("t1", "search"), // 3
      toolResultMsg([{ id: "t1", content: "result" }]), // 4 ← naïve cut lands here
      msg("assistant", "d"),
      msg("user", "e"),
      msg("assistant", "f"),
      msg("user", "g"),
      msg("assistant", "h"),
      msg("user", "i"),
      msg("assistant", "j"),
      msg("user", "k"),
    ];
    // 30% of 13 = 3.9 → ceil = 4 → drop first 4, keep from index 4
    // messages[4] is user with tool_result → snapToPairBoundary snaps to 3

    const countTokens = vi.fn().mockResolvedValueOnce(960).mockResolvedValueOnce(400);

    const result = await compactMessages("system", msgs13, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
    });

    assertNoOrphanedToolResults(result.messages);
  });

  it("summarization never orphans a tool_use/tool_result pair", async () => {
    // Place a tool pair right at the summarize boundary
    // keepTurns=6 → splitIdx = messages.length - 6
    const messages: Message[] = [
      msg("user", "old1"), // 0
      msg("assistant", "old2"), // 1
      toolCallMsg("t1", "search"), // 2: assistant with tool_use
      toolResultMsg([{ id: "t1", content: "result" }]), // 3: user with tool_result
      msg("assistant", "used the result"), // 4
      msg("user", "q1"), // 5 ← raw splitIdx = 9-6 = 3, snaps to 2
      msg("assistant", "a1"), // 6
      msg("user", "q2"), // 7
      msg("assistant", "a2"), // 8
    ];

    const countTokens = vi.fn().mockResolvedValueOnce(850).mockResolvedValueOnce(300);

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      summarize: vi.fn().mockResolvedValue("summary of old conversation"),
    });

    expect(result.didCompact).toBe(true);

    assertNoOrphanedToolResults(result.messages);
  });
});

describe("shouldSkipCounting", () => {
  it("returns false when no prior usage data", () => {
    expect(shouldSkipCounting(null, null, 100, 200_000)).toBe(false);
  });

  it("returns false when only input is known", () => {
    // Missing output = unknown — force count.
    expect(shouldSkipCounting(10_000, null, 400, 200_000)).toBe(false);
  });

  it("returns false when only output is known", () => {
    expect(shouldSkipCounting(null, 500, 400, 200_000)).toBe(false);
  });

  it("returns true when clearly under budget", () => {
    // 10_000 + 500 + 400/4 = 10_600, budget * 0.5 = 100_000
    expect(shouldSkipCounting(10_000, 500, 400, 200_000)).toBe(true);
  });

  it("returns false when the output term alone pushes past the 50% threshold", () => {
    // Without the output term, lastIn + newChars/4 = 90_000 + 100 = 90_100 < 100_000 → skip.
    // With output:            90_000 + 20_000 + 100 = 110_100 ≥ 100_000 → do NOT skip.
    // This is the regression the fix guards against — one response worth of
    // tokens that the old estimator ignored.
    expect(shouldSkipCounting(90_000, 20_000, 400, 200_000)).toBe(false);
  });

  it("returns false when estimate is near budget", () => {
    // 90_000 + 0 + 40_000/4 = 100_000, budget * 0.5 = 100_000 → strict < → not skipped
    expect(shouldSkipCounting(90_000, 0, 40_000, 200_000)).toBe(false);
  });

  it("returns false at exactly the 50% boundary", () => {
    // 40_000 + 10_000 + 200_000/4 = 100_000 = budget * 0.5 → strict < → not skipped
    expect(shouldSkipCounting(40_000, 10_000, 200_000, 200_000)).toBe(false);
  });

  it("returns true just under the 50% boundary", () => {
    // 40_000 + 10_000 + 199_996/4 = 99_999 < 100_000 → skip
    expect(shouldSkipCounting(40_000, 10_000, 199_996, 200_000)).toBe(true);
  });

  it("returns false when either value is the pre-migration -1 sentinel", () => {
    // -1 on either field means "unknown" — force a real count.
    expect(shouldSkipCounting(-1, 500, 400, 200_000)).toBe(false);
    expect(shouldSkipCounting(10_000, -1, 400, 200_000)).toBe(false);
    expect(shouldSkipCounting(-1, -1, 400, 200_000)).toBe(false);
  });
});

describe("the summarized count", () => {
  // Load-bearing for durable summaries: `handle-message` treats
  // `messagesSummarized` as an index into the history it loaded, mapping it to
  // a `through_message_id`. That holds because nothing before summarization
  // changes the array: Strategy 1 is an intent on the request.
  const cluster = (n: number): Message[] =>
    Array.from({ length: n }, (_, i) => [
      toolCallMsg(`t${i}`, "read_file"),
      toolResultMsg([{ id: `t${i}`, content: `contents of file ${i} `.repeat(40) }]),
    ]).flat();

  it("reports a summarized count that indexes the input array", async () => {
    const messages = [
      ...cluster(3),
      ...Array.from({ length: 6 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `tail ${i}`)),
    ];
    const summarize = vi.fn().mockResolvedValue("a summary");

    const result = await compactMessages(
      "system",
      messages,
      undefined,
      {
        countTokens: vi.fn().mockResolvedValue(900),
        budget: 1000,
        clearToolResults: CLEARING,
        summarize,
      },
      false,
    );

    const summarized = result.event?.messagesSummarized ?? 0;
    expect(summarized).toBeGreaterThan(0);
    // The prefix handed to the summarizer is exactly `input.slice(0, count)`.
    const prefix: Message[] = expectDefined(summarize.mock.calls[0], "summarize call")[1];
    expect(prefix).toEqual(messages.slice(0, summarized));
  });
});

describe("prefix veto", () => {
  function summarizeDeps(
    summarize: NonNullable<ContextManagerDeps["summarize"]>,
  ): ContextManagerDeps {
    return {
      countTokens: vi.fn().mockResolvedValue(900),
      budget: 1000,
      clearToolResults: CLEARING,
      summarize,
    };
  }

  const sevenMessages = () =>
    Array.from({ length: 7 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `turn ${i}`));

  it("summarizes a one-message prefix when no veto is supplied", async () => {
    // 7 messages at keepTurns 6 splits at 1. Size is not what makes a prefix
    // worth summarizing: one enormous message is the best case for Strategy 2,
    // and refusing it would hand the turn to lossy truncation.
    const summarize = vi.fn().mockResolvedValue("a summary");

    const result = await compactMessages(
      "system",
      sevenMessages(),
      undefined,
      summarizeDeps(summarize),
    );

    expect(summarize).toHaveBeenCalledOnce();
    expect(result.event?.messagesSummarized).toBe(1);
  });

  it("skips the LLM call when the caller vetoes the split", async () => {
    const summarize = vi.fn().mockResolvedValue("a summary");
    const canSummarizePrefix = vi.fn().mockReturnValue(false);

    const result = await compactMessages("system", sevenMessages(), undefined, {
      ...summarizeDeps(summarize),
      canSummarizePrefix,
    });

    expect(canSummarizePrefix).toHaveBeenCalledWith(1);
    expect(summarize).not.toHaveBeenCalled();
    expect(result.event?.strategies ?? []).not.toContain("summarize");
  });

  it("consults the veto with the chosen split, after pair-snapping", async () => {
    // The veto has to see the index the summary would actually cover, not the
    // raw `length - keepTurns` — the caller maps it back to a message id.
    const canSummarizePrefix = vi.fn().mockReturnValue(true);
    const messages = [
      msg("user", "t0"),
      msg("assistant", "t1"),
      toolCallMsg("t9", "read_file"),
      toolResultMsg([{ id: "t9", content: "x" }]),
      ...Array.from({ length: 5 }, (_, i) => msg(i % 2 === 0 ? "assistant" : "user", `u${i}`)),
    ];

    await compactMessages("system", messages, undefined, {
      ...summarizeDeps(vi.fn().mockResolvedValue("a summary")),
      canSummarizePrefix,
    });

    // 9 entries, keepTurns 6 → raw split 3, which lands on the user-role
    // tool_result and snaps back to 2 so the pair stays intact.
    expect(canSummarizePrefix).toHaveBeenCalledWith(2);
  });
});

describe("summarizationRequest", () => {
  it("repairs an orphan tool_use at the prefix tail", () => {
    // A split can land right after an assistant `tool_use` that history never
    // answered — a shape `validateHistory` exists for. Compaction runs upstream
    // of the agent loop's sanitizer, so this is the one LLM call in a turn that
    // would otherwise be built from raw history, and Anthropic rejects it.
    const params = summarizationRequest({
      model: "m",
      system: "s",
      messages: [msg("user", "do it"), toolCallMsg("t1", "read_file")],
      maxOutputTokens: 8192,
    });

    // The synthesized answer sits between the orphan call and the instruction.
    expect(expectDefined(params.messages.at(-2), "answering message")).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1" }],
    });
  });

  it("joins several text blocks on a paragraph break rather than fusing them", () => {
    // Blocks in a non-streaming response are discrete units. Joining with
    // nothing would run the last sentence of one into the first of the next,
    // and the result is stored rather than recomputed on the next turn.
    expect(
      extractSummaryText([
        { type: "text", text: "They settled the schema." },
        { type: "text", text: "Then they moved on." },
      ]),
    ).toBe("They settled the schema.\n\nThen they moved on.");
  });

  it("drops non-text blocks", () => {
    expect(
      extractSummaryText([
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "text", text: "the summary" },
      ]),
    ).toBe("the summary");
  });

  it("appends the instruction as the final user message", () => {
    const params = summarizationRequest({
      model: "m",
      system: "s",
      messages: [msg("user", "hello"), msg("assistant", "hi")],
      maxOutputTokens: 8192,
    });

    expect(params.messages.at(-1)).toEqual({ role: "user", content: SUMMARIZATION_PROMPT });
    expect(params.messages).toHaveLength(3);
  });

  it("carries the turn's Strategy 1 intent, and none without one", () => {
    const messages = [msg("user", "hello"), msg("assistant", "hi")];

    expect(
      summarizationRequest({
        model: "m",
        system: "s",
        messages,
        maxOutputTokens: 8192,
        clearToolResults: CLEARING,
      }).clearToolResults,
    ).toEqual(CLEARING);
    expect(
      summarizationRequest({ model: "m", system: "s", messages, maxOutputTokens: 8192 }),
    ).not.toHaveProperty("clearToolResults");
  });

  it("caps output at the model's own ceiling when it is below the default", () => {
    expect(
      summarizationRequest({ model: "m", system: "s", messages: [], maxOutputTokens: 4096 })
        .maxTokens,
    ).toBe(4096);
    expect(
      summarizationRequest({ model: "m", system: "s", messages: [], maxOutputTokens: 64_000 })
        .maxTokens,
    ).toBe(16_000);
  });
});
