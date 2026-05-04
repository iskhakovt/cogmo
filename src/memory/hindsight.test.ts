import { describe, expect, it, vi } from "vitest";
import { HindsightMemoryProvider } from "./hindsight.js";

// Mock the HindsightClient — we don't want real HTTP calls
const mockRetain = vi
  .fn()
  .mockResolvedValue({ success: true, bank_id: "test", items_count: 1, async: false });
const mockRetainBatch = vi
  .fn()
  .mockResolvedValue({ success: true, bank_id: "test", items_count: 2, async: true });
const mockRecall = vi.fn();
const mockReflect = vi.fn();

vi.mock("@vectorize-io/hindsight-client", () => {
  class HindsightError extends Error {
    statusCode: number;
    details: string;
    constructor(message: string, statusCode: number, details: string) {
      super(message);
      this.name = "HindsightError";
      this.statusCode = statusCode;
      this.details = details;
    }
  }
  return {
    HindsightClient: class {
      retain = mockRetain;
      retainBatch = mockRetainBatch;
      recall = mockRecall;
      reflect = mockReflect;
    },
    HindsightError,
  };
});

// Imported after vi.mock so the test class matches the one the provider sees
const { HindsightError: MockHindsightError } = await import("@vectorize-io/hindsight-client");

function createProvider(opts?: { maxQueryTokens?: number }): HindsightMemoryProvider {
  mockRetain.mockClear();
  mockRetainBatch.mockClear();
  mockRecall.mockClear();
  mockReflect.mockClear();
  return new HindsightMemoryProvider("http://localhost:8888", opts);
}

describe("HindsightMemoryProvider", () => {
  it("retain passes content and options to client", async () => {
    const provider = createProvider();

    await provider.retain("bank-1", "user likes coffee", {
      context: "morning chat",
      tags: ["preference"],
    });

    expect(mockRetain).toHaveBeenCalledWith("bank-1", "user likes coffee", {
      async: true,
      context: "morning chat",
      tags: ["preference"],
    });
  });

  it("retainBatch maps items to client with observation_scopes", async () => {
    const provider = createProvider();

    await provider.retainBatch("bank-1", [
      {
        content: "homelab IP is 10.0.10.10",
        tags: ["network:world"],
        observationScopes: "per_tag",
      },
      {
        content: "user prefers tables over prose",
        tags: ["network:bank"],
        context: "style preference",
        observationScopes: "per_tag",
      },
    ]);

    expect(mockRetainBatch).toHaveBeenCalledWith(
      "bank-1",
      [
        {
          content: "homelab IP is 10.0.10.10",
          tags: ["network:world"],
          observation_scopes: "per_tag",
        },
        {
          content: "user prefers tables over prose",
          tags: ["network:bank"],
          context: "style preference",
          observation_scopes: "per_tag",
        },
      ],
      { async: true },
    );
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

  it("recall passes tagsMatch to client", async () => {
    const provider = createProvider();
    mockRecall.mockResolvedValueOnce({ results: [] });

    await provider.recall("bank-1", "query", {
      tags: ["network:world"],
      tagsMatch: "any_strict",
    });

    expect(mockRecall).toHaveBeenCalledWith("bank-1", "query", {
      tags: ["network:world"],
      tagsMatch: "any_strict",
    });
  });

  it("reflect passes tagsMatch to client", async () => {
    const provider = createProvider();
    mockReflect.mockResolvedValueOnce({ text: "answer" });

    await provider.reflect("bank-1", "query", {
      tags: ["network:bank"],
      tagsMatch: "all",
    });

    expect(mockReflect).toHaveBeenCalledWith("bank-1", "query", {
      tags: ["network:bank"],
      tagsMatch: "all",
    });
  });

  it("reflect passes budget to client", async () => {
    const provider = createProvider();
    mockReflect.mockResolvedValueOnce({ text: "answer" });

    await provider.reflect("bank-1", "query", { budget: "high" });

    expect(mockReflect).toHaveBeenCalledWith("bank-1", "query", { budget: "high" });
  });

  it("reflect omits budget when undefined", async () => {
    const provider = createProvider();
    mockReflect.mockResolvedValueOnce({ text: "answer" });

    await provider.reflect("bank-1", "query");

    expect(mockReflect).toHaveBeenCalledWith("bank-1", "query", {});
  });

  it("recall truncates queries that exceed maxQueryTokens", async () => {
    const provider = createProvider({ maxQueryTokens: 10 });
    mockRecall.mockResolvedValueOnce({ results: [] });

    // ~80 cl100k_base tokens — well past the 10-token cap
    const longQuery = "the quick brown fox jumps over the lazy dog ".repeat(20);
    await provider.recall("bank-1", longQuery);

    expect(mockRecall).toHaveBeenCalledTimes(1);
    const sentQuery = mockRecall.mock.calls[0]?.[1] as string;
    expect(sentQuery.length).toBeLessThan(longQuery.length);
    expect(longQuery.startsWith(sentQuery)).toBe(true);
  });

  it("recall passes short queries through unchanged", async () => {
    const provider = createProvider({ maxQueryTokens: 500 });
    mockRecall.mockResolvedValueOnce({ results: [] });

    await provider.recall("bank-1", "what does the user like?");

    expect(mockRecall).toHaveBeenCalledWith("bank-1", "what does the user like?", {});
  });

  it("recall does not retry on 4xx HindsightError", async () => {
    const provider = createProvider();
    mockRecall.mockRejectedValue(new MockHindsightError("bad request", 400, "Query too long"));

    await expect(provider.recall("bank-1", "q")).rejects.toThrow("bad request");
    // Single attempt — withRetry's AbortError opt-out kicked in
    expect(mockRecall).toHaveBeenCalledTimes(1);
  });

  it("recall retries on 5xx HindsightError", async () => {
    const provider = createProvider();
    mockRecall
      .mockRejectedValueOnce(new MockHindsightError("server error", 503, "upstream down"))
      .mockResolvedValueOnce({ results: [] });

    const result = await provider.recall("bank-1", "q");

    expect(result.memories).toEqual([]);
    expect(mockRecall).toHaveBeenCalledTimes(2);
  });

  it("recall retries on 429 HindsightError (rate limiting is transient)", async () => {
    const provider = createProvider();
    mockRecall
      .mockRejectedValueOnce(new MockHindsightError("rate limited", 429, "Too Many Requests"))
      .mockResolvedValueOnce({ results: [] });

    const result = await provider.recall("bank-1", "q");

    expect(result.memories).toEqual([]);
    expect(mockRecall).toHaveBeenCalledTimes(2);
  });
});
