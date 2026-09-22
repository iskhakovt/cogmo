import { getEncoding } from "js-tiktoken";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { HindsightMemoryProvider } from "./hindsight.js";

// Mock the hindsight client module — we don't want real HTTP calls.
// retain + retainBatch still go through the class wrapper; recall + reflect
// go through the sdk_gen functions (the class options object doesn't expose
// `tag_groups`).
const mockRetain = vi
  .fn()
  .mockResolvedValue({ success: true, bank_id: "test", items_count: 1, async: false });
const mockRetainBatch = vi
  .fn()
  .mockResolvedValue({ success: true, bank_id: "test", items_count: 2, async: true });
const mockRecallMemories = vi.fn();
const mockReflect = vi.fn();
const mockGetVersion = vi.fn();
const fakeSdkClient = { __sdkClient: true };
const mockClientConstructor = vi.fn();
const mockCreateConfig = vi.fn();

vi.mock("@vectorize-io/hindsight-client", () => {
  return {
    CLIENT_VERSION: "0.9.1",
    HindsightClient: class {
      retain = mockRetain;
      retainBatch = mockRetainBatch;
      constructor(options: unknown) {
        mockClientConstructor(options);
      }
    },
    createClient: () => fakeSdkClient,
    createConfig: (config: unknown) => {
      mockCreateConfig(config);
      return {};
    },
    sdk: {
      recallMemories: (...args: unknown[]) => mockRecallMemories(...args),
      reflect: (...args: unknown[]) => mockReflect(...args),
      getVersion: (...args: unknown[]) => mockGetVersion(...args),
    },
  };
});

function createProvider(opts?: { maxQueryTokens?: number }): HindsightMemoryProvider {
  mockRetain.mockClear();
  mockRetainBatch.mockClear();
  mockRecallMemories.mockClear();
  mockReflect.mockClear();
  return new HindsightMemoryProvider("http://localhost:8888", { apiKey: "test-api-key", ...opts });
}

function okRecall(results: Array<Record<string, unknown>>) {
  return { data: { results }, error: undefined, response: { status: 200 } };
}
function okReflect(text: string) {
  return { data: { text }, error: undefined, response: { status: 200 } };
}
function errResp(status: number, detail = "boom") {
  return { data: undefined, error: { detail }, response: { status } };
}

describe("HindsightMemoryProvider", () => {
  it("authenticates both the class client and the raw sdk client with the API key", () => {
    createProvider();

    expect(mockClientConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://localhost:8888", apiKey: "test-api-key" }),
    );
    // The raw client has no apiKey option.
    expect(mockCreateConfig).toHaveBeenCalledWith({
      baseUrl: "http://localhost:8888",
      headers: { Authorization: "Bearer test-api-key" },
    });
  });

  it("getServerVersion bounds the version request with the caller's signal", async () => {
    const provider = createProvider();
    mockGetVersion.mockResolvedValue({
      data: { api_version: "0.9.1" },
      error: undefined,
      response: { status: 200 },
    });
    const signal = new AbortController().signal;

    await expect(provider.getServerVersion(signal)).resolves.toBe("0.9.1");

    expect(mockGetVersion).toHaveBeenCalledWith({ client: fakeSdkClient, signal });
  });

  it("getServerVersion keeps the message of a failed or aborted request", async () => {
    const provider = createProvider();
    // The generated client returns fetch failures in `error` instead of throwing.
    mockGetVersion.mockResolvedValue({
      data: undefined,
      error: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      response: undefined,
    });

    await expect(provider.getServerVersion()).rejects.toThrow(
      "hindsight /version failed: ? The operation was aborted due to timeout",
    );
  });

  it("recall keeps the message of a failed request instead of printing {}", async () => {
    vi.stubEnv("RETRY_DISABLED", "true");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const provider = createProvider();
    mockRecallMemories.mockResolvedValue({
      data: undefined,
      error: new TypeError("fetch failed"),
      response: undefined,
    });

    await expect(provider.recall("bank-1", "q")).rejects.toThrow("recall ?: fetch failed");
  });

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

    expect(mockRetainBatch).toHaveBeenCalledTimes(1);
    expect(mockRetainBatch).toHaveBeenCalledWith(
      "bank-1",
      [
        {
          content: "homelab IP is 10.0.10.10",
          document_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          tags: ["network:world"],
          observation_scopes: "per_tag",
        },
        {
          content: "user prefers tables over prose",
          document_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          tags: ["network:bank"],
          context: "style preference",
          observation_scopes: "per_tag",
        },
      ],
      { async: true },
    );
    const items = mockRetainBatch.mock.calls[0]?.[1] as Array<{ document_id: string }>;
    expect(items[0]?.document_id).not.toBe(items[1]?.document_id);
  });

  it("recall maps response to Memory array", async () => {
    const provider = createProvider();
    mockRecallMemories.mockResolvedValueOnce(
      okRecall([
        { id: "1", text: "user likes coffee", type: "fact", metadata: { source: "chat" } },
        { id: "2", text: "user is a developer", type: "fact" },
      ]),
    );

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
    mockRecallMemories.mockResolvedValueOnce(okRecall([]));

    const result = await provider.recall("bank-1", "unknown topic");

    expect(result.memories).toEqual([]);
  });

  it("recall sends a properly-shaped request body", async () => {
    const provider = createProvider();
    mockRecallMemories.mockResolvedValueOnce(okRecall([]));

    await provider.recall("bank-1", "query", {
      maxTokens: 1000,
      tags: ["network:world"],
      tagsMatch: "any_strict",
    });

    expect(mockRecallMemories).toHaveBeenCalledWith({
      client: fakeSdkClient,
      path: { bank_id: "bank-1" },
      body: {
        query: "query",
        // Adapter overrides Hindsight's default `["world", "experience"]` so
        // observation-type facts aren't silently filtered out.
        types: ["world", "experience", "observation"],
        max_tokens: 1000,
        tags: ["network:world"],
        tags_match: "any_strict",
      },
    });
  });

  it("recall passes tagGroups through unchanged", async () => {
    const provider = createProvider();
    mockRecallMemories.mockResolvedValueOnce(okRecall([]));

    const tagGroups = [
      {
        and: [
          { tags: ["compartment:work"], match: "any_strict" as const },
          { tags: ["trust:first-party"], match: "any_strict" as const },
        ],
      },
    ];
    await provider.recall("bank-1", "query", { tagGroups });

    const call = mockRecallMemories.mock.calls[0]?.[0] as { body: { tag_groups: unknown } };
    expect(call.body.tag_groups).toEqual(tagGroups);
  });

  it("reflect returns answer from response text", async () => {
    const provider = createProvider();
    mockReflect.mockResolvedValueOnce(okReflect("The user prefers dark roast coffee."));

    const result = await provider.reflect("bank-1", "what coffee does the user like?");

    expect(result.answer).toBe("The user prefers dark roast coffee.");
  });

  it("reflect sends a properly-shaped request body", async () => {
    const provider = createProvider();
    mockReflect.mockResolvedValueOnce(okReflect("answer"));

    await provider.reflect("bank-1", "query", {
      context: "conversation about food",
      tags: ["preference"],
      tagsMatch: "any",
      budget: "high",
    });

    expect(mockReflect).toHaveBeenCalledWith({
      client: fakeSdkClient,
      path: { bank_id: "bank-1" },
      body: {
        query: "query",
        context: "conversation about food",
        tags: ["preference"],
        tags_match: "any",
        budget: "high",
      },
    });
  });

  it("reflect passes tagGroups through unchanged", async () => {
    const provider = createProvider();
    mockReflect.mockResolvedValueOnce(okReflect("answer"));

    const tagGroups = [{ and: [{ tags: ["compartment:work"], match: "any_strict" as const }] }];
    await provider.reflect("bank-1", "query", { tagGroups });

    const call = mockReflect.mock.calls[0]?.[0] as { body: { tag_groups: unknown } };
    expect(call.body.tag_groups).toEqual(tagGroups);
  });

  it("recall truncates queries that exceed maxQueryTokens", async () => {
    const provider = createProvider({ maxQueryTokens: 10 });
    mockRecallMemories.mockResolvedValueOnce(okRecall([]));

    // ~80 o200k_base tokens — well past the 10-token cap
    const longQuery = "the quick brown fox jumps over the lazy dog ".repeat(20);
    await provider.recall("bank-1", longQuery);

    expect(mockRecallMemories).toHaveBeenCalledTimes(1);
    const call = mockRecallMemories.mock.calls[0]?.[0] as { body: { query: string } };
    const sent = call.body.query;
    expect(sent.length).toBeLessThan(longQuery.length);
    expect(longQuery.startsWith(sent)).toBe(true);
  });

  it("recall truncates to the cap as Hindsight counts it, in o200k_base", async () => {
    const provider = createProvider({ maxQueryTokens: 500 });
    mockRecallMemories.mockResolvedValueOnce(okRecall([]));

    // 15 o200k_base tokens per sentence against 10 cl100k_base ones, so a
    // query cut to 500 tokens in the wrong vocabulary is far over the cap.
    const longQuery = "PostgreSQL deduplicates orthogonal hardcoded rows cleanly. ".repeat(100);
    await provider.recall("bank-1", longQuery);

    const call = mockRecallMemories.mock.calls[0]?.[0] as { body: { query: string } };
    const sentTokens = getEncoding("o200k_base").encode(call.body.query).length;
    expect(sentTokens).toBeLessThanOrEqual(500);
    expect(sentTokens).toBeGreaterThan(490);
    expect(longQuery.startsWith(call.body.query)).toBe(true);
  });

  it("recall passes short queries through unchanged", async () => {
    const provider = createProvider({ maxQueryTokens: 500 });
    mockRecallMemories.mockResolvedValueOnce(okRecall([]));

    await provider.recall("bank-1", "what does the user like?");

    const call = mockRecallMemories.mock.calls[0]?.[0] as { body: { query: string } };
    expect(call.body.query).toBe("what does the user like?");
  });

  it("recall does not retry on 4xx errors", async () => {
    const provider = createProvider();
    mockRecallMemories.mockResolvedValue(errResp(400, "Query too long"));

    await expect(provider.recall("bank-1", "q")).rejects.toThrow(/recall 400/);
    // Single attempt — AbortError opt-out kicked in
    expect(mockRecallMemories).toHaveBeenCalledTimes(1);
  });

  it("recall returns no memories for a bank that has never been created", async () => {
    const provider = createProvider();
    mockRecallMemories.mockResolvedValue(errResp(404, "Bank 'bank-1' not found"));

    const result = await provider.recall("bank-1", "q");

    expect(result.memories).toEqual([]);
    expect(mockRecallMemories).toHaveBeenCalledTimes(1);
  });

  it("recall fails on a 404 that does not name the bank", async () => {
    const provider = createProvider();
    mockRecallMemories.mockResolvedValue(errResp(404, "Not Found"));

    await expect(provider.recall("bank-1", "q")).rejects.toThrow(/recall 404/);
    expect(mockRecallMemories).toHaveBeenCalledTimes(1);
  });

  it("recall retries on 5xx errors", async () => {
    const provider = createProvider();
    mockRecallMemories
      .mockResolvedValueOnce(errResp(503, "upstream down"))
      .mockResolvedValueOnce(okRecall([]));

    const result = await provider.recall("bank-1", "q");

    expect(result.memories).toEqual([]);
    expect(mockRecallMemories).toHaveBeenCalledTimes(2);
  });

  // 10s timeout because withRetry's 2-attempt 5s budget can land just past
  // vitest's default 5s under load.
  it("recall surfaces network-level failures (sdk_gen rejects with TypeError)", {
    timeout: 10_000,
  }, async () => {
    const provider = createProvider();
    // sdk_gen / native fetch rejects with TypeError("fetch failed") on
    // connection-level errors (refused, DNS, reset). withRetry must
    // propagate after the retry budget is exhausted, not swallow.
    mockRecallMemories.mockRejectedValue(new TypeError("fetch failed"));

    await expect(provider.recall("bank-1", "q")).rejects.toThrow(/fetch failed/);
  });

  it("recall retries on 429 (rate limiting is transient)", async () => {
    const provider = createProvider();
    mockRecallMemories
      .mockResolvedValueOnce(errResp(429, "Too Many Requests"))
      .mockResolvedValueOnce(okRecall([]));

    const result = await provider.recall("bank-1", "q");

    expect(result.memories).toEqual([]);
    expect(mockRecallMemories).toHaveBeenCalledTimes(2);
  });
});
