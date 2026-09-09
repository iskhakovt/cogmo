import { describe, expect, it, vi } from "vitest";
import { fakeRunInTx, mockAgentStore } from "../../test/factories.js";
import type { CompactionSummary } from "../store/index.js";
import { loadTurnHistory, summaryCutoffFor } from "./load-turn-history.js";

function summaryRow(overrides: Partial<CompactionSummary> = {}): CompactionSummary {
  return {
    id: "sum-1",
    conversationId: "conv-1",
    summary: "what happened earlier",
    throughMessageId: "m3",
    messagesSummarized: 3,
    model: "claude-haiku-4-5",
    source: "turn",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("loadTurnHistory", () => {
  it("returns the full transcript with aligned ids when nothing has been compacted", async () => {
    const agentStore = mockAgentStore({
      getLatestSummary: vi.fn().mockResolvedValue(undefined),
      listMessages: vi.fn().mockResolvedValue([
        { id: "m1", role: "user", content: "hi" },
        { id: "m2", role: "assistant", content: "hello" },
      ]),
    });

    const result = await loadTurnHistory(
      { runInTx: fakeRunInTx, agentStore },
      { conversationId: "conv-1" },
    );

    expect(result.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(result.messageIds).toEqual(["m1", "m2"]);
    expect(agentStore.getHistoryAfter).not.toHaveBeenCalled();
  });

  it("replaces the covered prefix with one synthetic summary message", async () => {
    const agentStore = mockAgentStore({
      getLatestSummary: vi.fn().mockResolvedValue(summaryRow()),
      getHistoryAfter: vi.fn().mockResolvedValue([
        { id: "m4", role: "user", content: "and then" },
        { id: "m5", role: "assistant", content: "right" },
      ]),
    });

    const result = await loadTurnHistory(
      { runInTx: fakeRunInTx, agentStore },
      { conversationId: "conv-1" },
    );

    expect(result.messages).toEqual([
      { role: "user", content: "[Previous conversation summary]\n\nwhat happened earlier" },
      { role: "user", content: "and then" },
      { role: "assistant", content: "right" },
    ]);
    // The synthetic entry has no row behind it, so its slot is null and every
    // real message keeps its own id one position to the right.
    expect(result.messageIds).toEqual([null, "m4", "m5"]);
    expect(agentStore.getHistoryAfter).toHaveBeenCalledWith(expect.anything(), "conv-1", "m3");
    expect(agentStore.listMessages).not.toHaveBeenCalled();
  });

  it("returns the summary alone when nothing has arrived since the cutoff", async () => {
    const agentStore = mockAgentStore({
      getLatestSummary: vi.fn().mockResolvedValue(summaryRow()),
      getHistoryAfter: vi.fn().mockResolvedValue([]),
    });

    const result = await loadTurnHistory(
      { runInTx: fakeRunInTx, agentStore },
      { conversationId: "conv-1" },
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messageIds).toEqual([null]);
  });

  it("keeps block content intact rather than flattening it to text", async () => {
    const blocks = [{ type: "text" as const, text: "with blocks" }];
    const agentStore = mockAgentStore({
      getLatestSummary: vi.fn().mockResolvedValue(undefined),
      listMessages: vi.fn().mockResolvedValue([{ id: "m1", role: "assistant", content: blocks }]),
    });

    const result = await loadTurnHistory(
      { runInTx: fakeRunInTx, agentStore },
      { conversationId: "conv-1" },
    );

    expect(result.messages[0]?.content).toEqual(blocks);
  });
});

describe("summaryCutoffFor", () => {
  it("returns the last real id inside the summarized span", () => {
    expect(summaryCutoffFor([null, "m4", "m5", "m6"], 3)).toBe("m5");
  });

  it("ignores ids past the split point", () => {
    expect(summaryCutoffFor(["m1", "m2", "m3"], 1)).toBe("m1");
  });

  it("returns null when the span holds only the previous summary", () => {
    expect(summaryCutoffFor([null, "m4"], 1)).toBeNull();
  });

  it("returns null for an empty span", () => {
    expect(summaryCutoffFor(["m1", "m2"], 0)).toBeNull();
  });

  it("clamps a split index past the end rather than reading off the array", () => {
    expect(summaryCutoffFor(["m1", "m2"], 99)).toBe("m2");
  });
});
