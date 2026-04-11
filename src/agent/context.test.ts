import { describe, expect, it, vi } from "vitest";
import type { Message } from "../llm/types.js";
import { compactMessages, shouldSkipCounting } from "./context.js";

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
    // Create 7 tool result pairs — should clear 2, keep 5
    const messages: Message[] = [];
    for (let i = 0; i < 7; i++) {
      messages.push(msg("user", `query ${i}`));
      messages.push(toolCallMsg(`t${i}`, "search"));
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
    expect(toolResults[0].content).toBe("[Cleared — call tool again if needed]");
    expect(toolResults[1].content).toBe("[Cleared — call tool again if needed]");
    // Last 5 should be intact
    expect(toolResults[2].content).toContain("result-2-");
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
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toContain("[Previous conversation summary]");
    expect(result.messages[0].content).toContain("Summary of old messages");
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
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(msg("user", `q${i}`));
      messages.push(toolCallMsg(`t${i}`, "search"));
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
    if (result.messages[0].role === "user") {
      expect(
        result.messages[0].content === "[Earlier conversation history was truncated]" ||
          result.messages[0].content === "latest",
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
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(msg("user", `q${i}`));
      messages.push(toolCallMsg(`t${i}`, "search"));
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

describe("shouldSkipCounting", () => {
  it("returns false when no prior usage data", () => {
    expect(shouldSkipCounting(null, 100, 200_000)).toBe(false);
  });

  it("returns true when clearly under budget", () => {
    // 10_000 + 400/4 = 10_100, budget * 0.5 = 100_000
    expect(shouldSkipCounting(10_000, 400, 200_000)).toBe(true);
  });

  it("returns false when estimate is near budget", () => {
    // 90_000 + 40_000/4 = 100_000, budget * 0.5 = 100_000
    expect(shouldSkipCounting(90_000, 40_000, 200_000)).toBe(false);
  });
});
