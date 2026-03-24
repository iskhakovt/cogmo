import { describe, expect, it, vi } from "vitest";
import { HindsightMemoryProvider } from "./hindsight.js";

// Mock the HindsightClient — we don't want real HTTP calls
const mockRetain = vi
  .fn()
  .mockResolvedValue({ success: true, bank_id: "test", items_count: 1, async: false });
const mockRecall = vi.fn();
const mockReflect = vi.fn();

vi.mock("@vectorize-io/hindsight-client", () => ({
  HindsightClient: class {
    retain = mockRetain;
    recall = mockRecall;
    reflect = mockReflect;
  },
}));

function createProvider(): HindsightMemoryProvider {
  mockRetain.mockClear();
  mockRecall.mockClear();
  mockReflect.mockClear();
  return new HindsightMemoryProvider("http://localhost:8888");
}

describe("HindsightMemoryProvider", () => {
  it("retain passes content and options to client", async () => {
    const provider = createProvider();

    await provider.retain("bank-1", "user likes coffee", {
      context: "morning chat",
      tags: ["preference"],
    });

    expect(mockRetain).toHaveBeenCalledWith("bank-1", "user likes coffee", {
      context: "morning chat",
      metadata: undefined,
      tags: ["preference"],
    });
  });

  it("recall maps response to Memory array", async () => {
    const provider = createProvider();
    mockRecall.mockResolvedValueOnce({
      results: [
        { id: "1", text: "user likes coffee", type: "fact", metadata: { source: "chat" } },
        { id: "2", text: "user is a developer", type: "fact" },
      ],
    });

    const result = await provider.recall("bank-1", "what does the user like?");

    expect(result.memories).toHaveLength(2);
    expect(result.memories[0]).toEqual({
      content: "user likes coffee",
      type: "fact",
      metadata: { source: "chat" },
    });
    expect(result.memories[1]).toEqual({
      content: "user is a developer",
      type: "fact",
      metadata: undefined,
    });
  });

  it("recall handles empty results", async () => {
    const provider = createProvider();
    mockRecall.mockResolvedValueOnce({ results: [] });

    const result = await provider.recall("bank-1", "unknown topic");

    expect(result.memories).toEqual([]);
  });

  it("reflect returns answer from response text", async () => {
    const provider = createProvider();
    mockReflect.mockResolvedValueOnce({ text: "The user prefers dark roast coffee." });

    const result = await provider.reflect("bank-1", "what coffee does the user like?");

    expect(result.answer).toBe("The user prefers dark roast coffee.");
  });

  it("reflect passes context and tags", async () => {
    const provider = createProvider();
    mockReflect.mockResolvedValueOnce({ text: "answer" });

    await provider.reflect("bank-1", "query", {
      context: "conversation about food",
      tags: ["preference"],
    });

    expect(mockReflect).toHaveBeenCalledWith("bank-1", "query", {
      context: "conversation about food",
      tags: ["preference"],
    });
  });
});
