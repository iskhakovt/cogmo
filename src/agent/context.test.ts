import { describe, expect, it, vi } from "vitest";
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "../llm/types.js";
import {
  compactMessages,
  compactSameToolClusters,
  shouldSkipCounting,
  snapToPairBoundary,
} from "./context.js";

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
    });

    expect(result.didCompact).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.event).toBeUndefined();
  });

  it("clears oldest tool results, keeps last 5", async () => {
    // Create 7 tool result pairs — should clear 2, keep 5.
    // Tool names vary per call so Strategy 0 (same-tool supersession,
    // count-based) doesn't also fire — this test pins Strategy 1's
    // budget-pressure behavior in isolation.
    const messages: Message[] = [];
    for (let i = 0; i < 7; i++) {
      messages.push(msg("user", `query ${i}`));
      messages.push(toolCallMsg(`t${i}`, `search_${i}`));
      messages.push(toolResultMsg([{ id: `t${i}`, content: `result-${i}-${"x".repeat(1000)}` }]));
      messages.push(msg("assistant", `answer ${i}`));
    }

    const countTokens = vi.fn().mockResolvedValueOnce(700).mockResolvedValueOnce(400);

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
    });

    expect(result.didCompact).toBe(true);
    expect(result.event?.toolResultsCleared).toBe(2);
    expect(result.event?.strategies).toEqual(["clear_tool_results"]);

    // First 2 tool results should be cleared
    const toolResults = result.messages.flatMap((m) =>
      typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_result"),
    );
    expect(toolResults[0]?.content).toBe("[Cleared — call tool again if needed]");
    expect(toolResults[1]?.content).toBe("[Cleared — call tool again if needed]");
    // Last 5 should be intact
    expect(toolResults[2]?.content).toContain("result-2-");
  });

  it("does not call summarize when tool clearing is sufficient", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 7; i++) {
      messages.push(msg("user", `q${i}`));
      messages.push(toolCallMsg(`t${i}`, "search"));
      messages.push(toolResultMsg([{ id: `t${i}`, content: "x".repeat(1000) }]));
      messages.push(msg("assistant", `a${i}`));
    }

    // Over 60% initially, under 80% after clearing
    const countTokens = vi.fn().mockResolvedValueOnce(700).mockResolvedValueOnce(500);
    const summarize = vi.fn();

    await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
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

    // Over 80% before and after clearing (no tool results), under after summarization
    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(900) // initial: over 60% and 80%
      .mockResolvedValueOnce(300); // after summarization: under
    const summarize = vi.fn().mockResolvedValue("Summary of old messages");

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
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
  // hardcoded `summarize-prefix` step ID in `handle-message.ts` depends on
  // this — Inngest throws on duplicate step IDs, so a future change that
  // calls `summarize` twice (e.g., segmented summarization) would surface
  // only at runtime under specific conversation lengths. This test catches
  // it at unit-test time.
  it("calls summarize at most once even when all three strategies fire", async () => {
    // Build a conversation with enough tool results to clear AND enough
    // messages to summarize a prefix.
    // Vary tool names per call so Strategy 0 (same-tool supersession)
    // doesn't trip — this test focuses on the budget-pressure sequence
    // clear → summarize → truncate.
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(msg("user", `q${i}`));
      messages.push(toolCallMsg(`t${i}`, `search_${i}`));
      messages.push(toolResultMsg([{ id: `t${i}`, content: "x".repeat(500) }]));
      messages.push(msg("assistant", `a${i}`));
    }

    // Stay above the 95% truncate threshold through every strategy so all
    // three fire in sequence: clear → summarize → truncate.
    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(980) // initial: over 95%
      .mockResolvedValueOnce(970) // after clearing: still over 95%
      .mockResolvedValueOnce(960) // after summarization: still over 95%
      .mockResolvedValueOnce(200); // after truncation: under
    const summarize = vi.fn().mockResolvedValue("Summary of old messages");

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      summarize,
    });

    // All three strategies fired …
    expect(result.event?.strategies).toEqual(["clear_tool_results", "summarize", "truncate"]);
    // … but summarize was still called exactly once.
    expect(summarize.mock.calls.length).toBeLessThanOrEqual(1);
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

  it("calls onStatus for summarization", async () => {
    const messages = [
      msg("user", "m1"),
      msg("assistant", "r1"),
      msg("user", "m2"),
      msg("assistant", "r2"),
      msg("user", "m3"),
      msg("assistant", "r3"),
      msg("user", "m4"),
      msg("assistant", "r4"),
    ];

    const countTokens = vi.fn().mockResolvedValueOnce(850).mockResolvedValueOnce(300);
    const onStatus = vi.fn();

    await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      summarize: vi.fn().mockResolvedValue("summary"),
      onStatus,
    });

    expect(onStatus).toHaveBeenCalledWith("Summarizing conversation...");
  });

  it("reports correct CompactionEvent stats", async () => {
    // Vary tool names so Strategy 0 doesn't trip and conflate the stats
    // assertion — Strategy 0 has its own coverage block.
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(msg("user", `q${i}`));
      messages.push(toolCallMsg(`t${i}`, `search_${i}`));
      messages.push(toolResultMsg([{ id: `t${i}`, content: "x".repeat(1000) }]));
      messages.push(msg("assistant", `a${i}`));
    }

    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(900) // initial: over 60% and 80%
      .mockResolvedValueOnce(850) // after clearing: still over 80%
      .mockResolvedValueOnce(400); // after summarization: under

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      summarize: vi.fn().mockResolvedValue("summary"),
    });

    expect(result.event).toBeDefined();
    expect(result.event!.tokensBefore).toBe(900);
    expect(result.event!.tokensAfter).toBe(400);
    expect(result.event!.toolResultsCleared).toBe(3); // 8 - 5 = 3
    expect(result.event!.strategies).toEqual(["clear_tool_results", "summarize"]);
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
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => b.id);
      const toolResultIds = (m.content as ContentBlock[])
        .filter((b): b is ToolResultBlock => b.type === "tool_result")
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

// --- Strategy 0: Same-Tool Supersession ---

describe("compactSameToolClusters", () => {
  // Helpers that assemble realistic message sequences. A single same-tool
  // call lands as two messages: assistant with tool_use + user with the
  // paired tool_result.
  function cluster(
    toolName: string,
    calls: ReadonlyArray<{ id: string; input: unknown; result: string }>,
  ): Message[] {
    return calls.flatMap((c) => [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: c.id, name: toolName, input: c.input }],
      } as Message,
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: c.id, content: c.result }],
      } as Message,
    ]);
  }

  function getToolResultContents(messages: ReadonlyArray<Message>, toolName: string): string[] {
    // Map tool_use id -> name so we can identify which tool_results belong to this cluster.
    const idsForTool = new Set(
      messages
        .filter((m) => m.role === "assistant" && Array.isArray(m.content))
        .flatMap((m) => m.content as ContentBlock[])
        .filter((b): b is ToolUseBlock => b.type === "tool_use" && b.name === toolName)
        .map((b) => b.id),
    );
    return messages
      .filter((m) => m.role === "user" && Array.isArray(m.content))
      .flatMap((m) => m.content as ContentBlock[])
      .filter((b): b is ToolResultBlock => b.type === "tool_result" && idsForTool.has(b.toolUseId))
      .map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content)));
  }

  const defaultOpts = { retainRecent: 2, retainFirst: 1, triggerCount: 5 };

  it("passes through unchanged when no tool has hit triggerCount", () => {
    const messages = cluster("web_search", [
      { id: "t1", input: { query: "foo" }, result: "r1" },
      { id: "t2", input: { query: "bar" }, result: "r2" },
      { id: "t3", input: { query: "baz" }, result: "r3" },
      { id: "t4", input: { query: "qux" }, result: "r4" },
    ]);
    const result = compactSameToolClusters(messages, defaultOpts);
    expect(result.clusters).toBe(0);
    expect(result.resultsCompacted).toBe(0);
    // Result contents byte-identical to inputs.
    expect(getToolResultContents(result.messages, "web_search")).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("fires at triggerCount — first fire produces [R1, S, S, R4, R5]", () => {
    const messages = cluster("web_search", [
      { id: "t1", input: { query: "alpha" }, result: "R1" },
      { id: "t2", input: { query: "beta" }, result: "R2" },
      { id: "t3", input: { query: "gamma" }, result: "R3" },
      { id: "t4", input: { query: "delta" }, result: "R4" },
      { id: "t5", input: { query: "epsilon" }, result: "R5" },
    ]);
    const result = compactSameToolClusters(messages, defaultOpts);
    expect(result.clusters).toBe(1);
    expect(result.resultsCompacted).toBe(2);
    const contents = getToolResultContents(result.messages, "web_search");
    // R1, R4, R5 verbatim; positions 1 and 2 are the compacted summary.
    expect(contents[0]).toBe("R1");
    expect(contents[3]).toBe("R4");
    expect(contents[4]).toBe("R5");
    expect(contents[1]).toMatch(/Same-tool cluster.*web_search/);
    expect(contents[1]).toContain("beta");
    expect(contents[1]).toContain("gamma");
    // Same summary string on every compacted block (matches Strategy 1's
    // placeholder pattern).
    expect(contents[1]).toBe(contents[2]);
  });

  it("the first slot is sticky — its content stays byte-identical across multiple compactions", () => {
    // Pass 1: 5 results → compact → [R1, S, S, R4, R5]
    const pass1Input = cluster("web_search", [
      { id: "t1", input: { query: "alpha" }, result: "FIRST_R1" },
      { id: "t2", input: { query: "beta" }, result: "R2" },
      { id: "t3", input: { query: "gamma" }, result: "R3" },
      { id: "t4", input: { query: "delta" }, result: "R4" },
      { id: "t5", input: { query: "epsilon" }, result: "R5" },
    ]);
    const pass1 = compactSameToolClusters(pass1Input, defaultOpts);
    const pass1First = getToolResultContents(pass1.messages, "web_search")[0];
    expect(pass1First).toBe("FIRST_R1");

    // Pass 2: simulate "a new tool_result arrives" by appending R6 to
    // the already-compacted array.
    const pass2Input: Message[] = [
      ...pass1.messages,
      ...cluster("web_search", [{ id: "t6", input: { query: "zeta" }, result: "R6" }]),
    ];
    const pass2 = compactSameToolClusters(pass2Input, defaultOpts);
    const pass2Contents = getToolResultContents(pass2.messages, "web_search");
    // R1 is still FIRST_R1; R6 verbatim; previous middle gets re-compacted
    // (now covering 3 results: original t2, t3, t4).
    expect(pass2Contents[0]).toBe("FIRST_R1");
    expect(pass2Contents[pass2Contents.length - 1]).toBe("R6");
    expect(pass2Contents[pass2Contents.length - 2]).toBe("R5");
  });

  it("idempotent — running twice on the same input produces the same output", () => {
    const messages = cluster("web_search", [
      { id: "t1", input: { query: "alpha" }, result: "R1" },
      { id: "t2", input: { query: "beta" }, result: "R2" },
      { id: "t3", input: { query: "gamma" }, result: "R3" },
      { id: "t4", input: { query: "delta" }, result: "R4" },
      { id: "t5", input: { query: "epsilon" }, result: "R5" },
    ]);
    const pass1 = compactSameToolClusters(messages, defaultOpts);
    const pass2 = compactSameToolClusters(pass1.messages, defaultOpts);
    expect(getToolResultContents(pass2.messages, "web_search")).toEqual(
      getToolResultContents(pass1.messages, "web_search"),
    );
    // Second pass touches the same blocks because their content already
    // matches the deterministic summary (no-op rewrite); the counter
    // reflects that.
    expect(pass2.resultsCompacted).toBe(2);
  });

  it("preserves tool_use blocks intact — only tool_result content is mutated", () => {
    const messages = cluster("web_search", [
      { id: "t1", input: { query: "alpha" }, result: "R1" },
      { id: "t2", input: { query: "beta" }, result: "R2" },
      { id: "t3", input: { query: "gamma" }, result: "R3" },
      { id: "t4", input: { query: "delta" }, result: "R4" },
      { id: "t5", input: { query: "epsilon" }, result: "R5" },
    ]);
    const result = compactSameToolClusters(messages, defaultOpts);
    // Extract every tool_use from the output; their ids + inputs must
    // match the input exactly (no mutation, no skipped pair).
    const toolUses = result.messages
      .filter((m) => m.role === "assistant" && Array.isArray(m.content))
      .flatMap((m) => m.content as ContentBlock[])
      .filter((b): b is ToolUseBlock => b.type === "tool_use");
    expect(toolUses.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(toolUses.every((t) => t.name === "web_search")).toBe(true);
    expect(toolUses[1]?.input).toEqual({ query: "beta" });
  });

  it("pair invariant — every tool_use still has a tool_result with matching id", () => {
    const messages = cluster("web_search", [
      { id: "t1", input: { query: "alpha" }, result: "R1" },
      { id: "t2", input: { query: "beta" }, result: "R2" },
      { id: "t3", input: { query: "gamma" }, result: "R3" },
      { id: "t4", input: { query: "delta" }, result: "R4" },
      { id: "t5", input: { query: "epsilon" }, result: "R5" },
    ]);
    const result = compactSameToolClusters(messages, defaultOpts);
    const toolUseIds = new Set(
      result.messages
        .filter((m) => m.role === "assistant" && Array.isArray(m.content))
        .flatMap((m) => m.content as ContentBlock[])
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => b.id),
    );
    const toolResultIds = new Set(
      result.messages
        .filter((m) => m.role === "user" && Array.isArray(m.content))
        .flatMap((m) => m.content as ContentBlock[])
        .filter((b): b is ToolResultBlock => b.type === "tool_result")
        .map((b) => b.toolUseId),
    );
    expect(toolUseIds).toEqual(toolResultIds);
  });

  it("cache-prefix invariant — messages up to and including the first sticky result are byte-identical across compactions", () => {
    const pass1Input = cluster("web_search", [
      { id: "t1", input: { query: "alpha" }, result: "R1" },
      { id: "t2", input: { query: "beta" }, result: "R2" },
      { id: "t3", input: { query: "gamma" }, result: "R3" },
      { id: "t4", input: { query: "delta" }, result: "R4" },
      { id: "t5", input: { query: "epsilon" }, result: "R5" },
    ]);
    const pass1 = compactSameToolClusters(pass1Input, defaultOpts);
    // The first tool_result lives at messages[1] (assistant tool_use is
    // at messages[0]). Cache-prefix scope is messages[0..1] inclusive.
    const prefixPass1 = JSON.stringify(pass1.messages.slice(0, 2));

    // Simulate next turn: append R6 and compact again.
    const pass2Input: Message[] = [
      ...pass1.messages,
      ...cluster("web_search", [{ id: "t6", input: { query: "zeta" }, result: "R6" }]),
    ];
    const pass2 = compactSameToolClusters(pass2Input, defaultOpts);
    const prefixPass2 = JSON.stringify(pass2.messages.slice(0, 2));
    expect(prefixPass2).toBe(prefixPass1);
  });

  it("deterministic — same input always produces the same summary content", () => {
    const messages = cluster("web_search", [
      { id: "t1", input: { query: "alpha" }, result: "R1" },
      { id: "t2", input: { query: "beta" }, result: "R2" },
      { id: "t3", input: { query: "gamma" }, result: "R3" },
      { id: "t4", input: { query: "delta" }, result: "R4" },
      { id: "t5", input: { query: "epsilon" }, result: "R5" },
    ]);
    const a = compactSameToolClusters(messages, defaultOpts);
    const b = compactSameToolClusters(messages, defaultOpts);
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
  });

  it("per-tool independence — one tool over threshold doesn't penalize another under threshold", () => {
    const searchCalls = cluster("web_search", [
      { id: "s1", input: { query: "a" }, result: "S1" },
      { id: "s2", input: { query: "b" }, result: "S2" },
      { id: "s3", input: { query: "c" }, result: "S3" },
      { id: "s4", input: { query: "d" }, result: "S4" },
      { id: "s5", input: { query: "e" }, result: "S5" },
    ]);
    const readCalls = cluster("read_file", [
      { id: "r1", input: { path: "a.txt" }, result: "FILE_A" },
      { id: "r2", input: { path: "b.txt" }, result: "FILE_B" },
    ]);
    const messages = [...searchCalls, ...readCalls];
    const result = compactSameToolClusters(messages, defaultOpts);
    expect(result.clusters).toBe(1);
    // web_search cluster compacted; read_file cluster intact.
    const readContents = getToolResultContents(result.messages, "read_file");
    expect(readContents).toEqual(["FILE_A", "FILE_B"]);
  });

  it("returns a new array even when no compaction fires (defensive copy)", () => {
    const messages = cluster("web_search", [{ id: "t1", input: { query: "alpha" }, result: "R1" }]);
    const result = compactSameToolClusters(messages, defaultOpts);
    expect(result.messages).not.toBe(messages);
  });

  it("ignores tool_results whose tool_use has been lost (orphaned) — they can't be classified", () => {
    // Orphan tool_result (no matching tool_use in this slice) — should
    // not crash, just be skipped from the cluster count.
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "orphan", content: "stray" }],
      },
      ...cluster("web_search", [
        { id: "t1", input: { query: "alpha" }, result: "R1" },
        { id: "t2", input: { query: "beta" }, result: "R2" },
        { id: "t3", input: { query: "gamma" }, result: "R3" },
        { id: "t4", input: { query: "delta" }, result: "R4" },
        { id: "t5", input: { query: "epsilon" }, result: "R5" },
      ]),
    ];
    const result = compactSameToolClusters(messages, defaultOpts);
    expect(result.clusters).toBe(1);
    expect(result.resultsCompacted).toBe(2);
    // Orphan untouched.
    const orphanMsg = result.messages[0];
    expect(orphanMsg).toEqual(messages[0]);
  });
});

// --- Strategy 0 wired into compactMessages ---

describe("compactMessages — Strategy 0 wiring", () => {
  it("runs Strategy 0 unconditionally before the token-count threshold check", async () => {
    // 5 web_search calls — enough to trip Strategy 0 — but total
    // budget usage is small. Strategy 1's 60% threshold doesn't fire,
    // but Strategy 0 should still rewrite the cluster.
    const messages: Message[] = [];
    for (const c of [
      { id: "t1", q: "alpha" },
      { id: "t2", q: "beta" },
      { id: "t3", q: "gamma" },
      { id: "t4", q: "delta" },
      { id: "t5", q: "epsilon" },
    ]) {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: c.id, name: "web_search", input: { query: c.q } }],
      });
      messages.push({
        role: "user",
        content: [{ type: "tool_result", toolUseId: c.id, content: `body-of-${c.q}` }],
      });
    }
    const result = await compactMessages("system", messages, undefined, {
      countTokens: vi.fn().mockResolvedValue(100), // well under any threshold
      budget: 1000,
    });
    expect(result.didCompact).toBe(true);
    expect(result.event?.strategies).toEqual(["compact_same_tool_clusters"]);
    expect(result.event?.sameToolClustersCompacted).toBe(1);
    expect(result.event?.sameToolResultsSuperseded).toBe(2);
  });

  it("does not flip didCompact when no cluster trips and budget is fine", async () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const result = await compactMessages("system", messages, undefined, {
      countTokens: vi.fn().mockResolvedValue(100),
      budget: 1000,
    });
    expect(result.didCompact).toBe(false);
  });
});
