import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebTools } from "./web-tools.js";

// Mock withRetry as a passthrough so we can exercise web-tools' error
// branches (5xx → throw, 4xx → AbortError) without paying the real
// retry backoff delays. The retry behaviour itself is covered in
// src/util/with-retry.test.ts.
//
// Limitation: this passthrough does NOT preserve pRetry's AbortError
// opt-out logic — both regular Errors and AbortErrors propagate
// identically here. That's fine for current tests (we only need the
// error branches to fire), but if a future test needs to assert
// "withRetry stopped retrying because of AbortError", it must use the
// real withRetry with vi.useFakeTimers() or run against the integration
// tier where RETRY_DISABLED already flattens retry behaviour.
vi.mock("../util/with-retry.js", async () => {
  const actual =
    await vi.importActual<typeof import("../util/with-retry.js")>("../util/with-retry.js");
  return {
    ...actual,
    withRetry: <T>(fn: () => Promise<T>) => fn(),
  };
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
  mockFetch.mockReset();
});

function stubService() {
  return {
    memory: {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
      retain: vi.fn().mockResolvedValue(undefined),
      reflect: vi.fn().mockResolvedValue({ answer: "" }),
    },
    files: {
      read: vi.fn().mockResolvedValue(""),
      write: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    coreMemory: {
      get: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("web_search", () => {
  it("returns formatted search results", async () => {
    const [search] = createWebTools("tavily-key", undefined);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          { title: "Result 1", url: "https://example.com/1", content: "Snippet 1" },
          { title: "Result 2", url: "https://example.com/2", content: "Snippet 2" },
        ],
      }),
    });

    const result = await search!.handler({ query: "test query", maxResults: 5 }, stubService());

    expect(result).toContain("[Result 1](https://example.com/1)");
    expect(result).toContain("Snippet 1");
    expect(result).toContain("[Result 2](https://example.com/2)");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer tavily-key" }),
      }),
    );
  });

  it("returns error when API key is missing", async () => {
    const [search] = createWebTools(undefined, undefined);
    const result = await search!.handler({ query: "test" }, stubService());

    expect(result).toContain("not configured");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws on API error", async () => {
    const [search] = createWebTools("key", undefined);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, text: async () => "rate limited" });

    await expect(search!.handler({ query: "test" }, stubService())).rejects.toThrow("429");
  });

  it("throws on server error (5xx)", async () => {
    const [search] = createWebTools("key", undefined);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => "down" });

    await expect(search!.handler({ query: "test" }, stubService())).rejects.toThrow(
      "Tavily API server error: 503",
    );
  });

  it("handles empty results", async () => {
    const [search] = createWebTools("key", undefined);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });

    const result = await search!.handler({ query: "obscure" }, stubService());
    expect(result).toBe("No results found.");
  });
});

describe("web_answer", () => {
  it("returns answer with citations", async () => {
    const tools = createWebTools(undefined, "or-key");
    const answer = tools[1]!;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "The answer is 42." } }],
        citations: ["https://source.com/1", "https://source.com/2"],
      }),
    });

    const result = await answer.handler({ question: "meaning of life" }, stubService());

    expect(result).toContain("The answer is 42.");
    expect(result).toContain("Sources:");
    expect(result).toContain("https://source.com/1");

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.model).toBe("perplexity/sonar");
  });

  it("returns answer without citations when none provided", async () => {
    const tools = createWebTools(undefined, "or-key");
    const answer = tools[1]!;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Just an answer." } }],
      }),
    });

    const result = await answer.handler({ question: "test" }, stubService());
    expect(result).toBe("Just an answer.");
    expect(result).not.toContain("Sources:");
  });

  it("returns error when API key is missing", async () => {
    const tools = createWebTools(undefined, undefined);
    const answer = tools[1]!;
    const result = await answer.handler({ question: "test" }, stubService());

    expect(result).toContain("not configured");
  });

  it("throws on server error (5xx)", async () => {
    const tools = createWebTools(undefined, "or-key");
    const answer = tools[1]!;
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502, text: async () => "bad gateway" });

    await expect(answer.handler({ question: "test" }, stubService())).rejects.toThrow(
      "OpenRouter API server error: 502",
    );
  });

  it("throws on client error (4xx)", async () => {
    const tools = createWebTools(undefined, "or-key");
    const answer = tools[1]!;
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "unauthorized" });

    await expect(answer.handler({ question: "test" }, stubService())).rejects.toThrow(
      "OpenRouter API error: 401",
    );
  });
});

describe("fetch_url", () => {
  it("extracts article content from HTML", async () => {
    const tools = createWebTools(undefined, undefined);
    const fetchUrl = tools[2]!;

    const html = `
      <html><body>
        <article>
          <h1>Test Article</h1>
          <p>This is the main content of the article. It has enough text to be considered the main content by the readability algorithm and extraction process.</p>
          <p>Another paragraph with substantial content that helps the readability parser determine this is meaningful article content worth extracting from the page.</p>
        </article>
      </body></html>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "text/html"]]),
      text: async () => html,
    });

    const result = await fetchUrl.handler({ url: "https://example.com/article" }, stubService());
    expect(result).toContain("main content");
  });

  it("returns raw text for non-HTML", async () => {
    const tools = createWebTools(undefined, undefined);
    const fetchUrl = tools[2]!;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "text/plain"]]),
      text: async () => "Plain text content",
    });

    const result = await fetchUrl.handler({ url: "https://example.com/file.txt" }, stubService());
    expect(result).toBe("Plain text content");
  });

  it("rejects private IPs", async () => {
    const tools = createWebTools(undefined, undefined);
    const fetchUrl = tools[2]!;

    await expect(
      fetchUrl.handler({ url: "https://192.168.1.1/secret" }, stubService()),
    ).rejects.toThrow("private/internal");

    await expect(fetchUrl.handler({ url: "https://localhost/api" }, stubService())).rejects.toThrow(
      "private/internal",
    );
  });

  it("rejects non-http protocols", async () => {
    const tools = createWebTools(undefined, undefined);
    const fetchUrl = tools[2]!;

    await expect(fetchUrl.handler({ url: "file:///etc/passwd" }, stubService())).rejects.toThrow(
      "Unsupported protocol",
    );
  });

  it("truncates large content", async () => {
    const tools = createWebTools(undefined, undefined);
    const fetchUrl = tools[2]!;

    const largeContent = "x".repeat(60_000);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "text/plain"]]),
      text: async () => largeContent,
    });

    const result = await fetchUrl.handler({ url: "https://example.com/big" }, stubService());
    expect(result).toContain("[Content truncated");
    expect(result.length).toBeLessThan(60_000);
  });

  it("throws on HTTP errors", async () => {
    const tools = createWebTools(undefined, undefined);
    const fetchUrl = tools[2]!;

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    await expect(
      fetchUrl.handler({ url: "https://example.com/missing" }, stubService()),
    ).rejects.toThrow("404");
  });

  it("throws on server error (5xx)", async () => {
    const tools = createWebTools(undefined, undefined);
    const fetchUrl = tools[2]!;

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });

    await expect(
      fetchUrl.handler({ url: "https://example.com/down" }, stubService()),
    ).rejects.toThrow("Fetch failed: 503");
  });
});
