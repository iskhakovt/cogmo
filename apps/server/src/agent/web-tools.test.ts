import { afterEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import type { Service } from "./service.js";
import { createWebTools } from "./web-tools.js";

// Mock withRetry as a no-delay retry loop that honours AbortError. We
// reproduce the retry semantics (including AbortError = stop) without
// paying the real exponential-backoff delays. The retry behaviour
// itself is covered in src/util/with-retry.test.ts.
//
// Tests that mock a 5xx (retryable) response must use mockResolvedValue
// instead of mockResolvedValueOnce — otherwise the second attempt sees
// `undefined` and throws a TypeError instead of the expected error.
vi.mock("../util/with-retry.js", async () => {
  const actual =
    await vi.importActual<typeof import("../util/with-retry.js")>("../util/with-retry.js");
  return {
    ...actual,
    withRetry: async <T>(fn: () => Promise<T>, opts?: { retries?: number }): Promise<T> => {
      const maxAttempts = (opts?.retries ?? 3) + 1;
      let lastError: unknown;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          return await fn();
        } catch (e) {
          lastError = e;
          if (e instanceof actual.AbortError) throw e;
        }
      }
      throw lastError;
    },
  };
});

// We type the call site (input + init) but leave the response as `unknown`
// so tests can return partial { ok, status, headers, json, text } shapes
// without the full Response surface. headers passed in are always plain
// records here.
type FetchInit = { headers?: Record<string, string>; body?: string; method?: string };
const mockFetch = vi.fn<(input: string, init?: FetchInit) => Promise<unknown>>();
vi.stubGlobal("fetch", mockFetch);

function fetchCall(index: number): { url: string; headers: Record<string, string>; body: string } {
  const call = mockFetch.mock.calls[index];
  if (!call) throw new Error(`expected fetch call at index ${index}`);
  const [url, init] = call;
  return { url, headers: init?.headers ?? {}, body: init?.body ?? "" };
}

afterEach(() => {
  mockFetch.mockReset();
});

// web tools don't read from Service — `mock<Service>()` gives us a typed
// proxy where every method is a vi.fn() returning undefined. Optional
// surfaces (`coding`, `skills`) are auto-mocked too; drop them so an
// accidental call surfaces as a missing-property error rather than silent
// success. exactOptionalPropertyTypes blocks `= undefined`, hence `delete`.
function stubService(): Service {
  const svc = mock<Service>();
  delete svc.coding;
  delete svc.skills;
  return svc;
}

const OpenRouterRequestBodySchema = z.object({ model: z.string() }).passthrough();

const TavilyExtractBodySchema = z
  .object({ urls: z.string(), extract_depth: z.string() })
  .passthrough();

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
    mockFetch.mockResolvedValue({ ok: false, status: 503, text: async () => "down" });

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

    const body = OpenRouterRequestBodySchema.parse(JSON.parse(fetchCall(0).body));
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
    mockFetch.mockResolvedValue({ ok: false, status: 502, text: async () => "bad gateway" });

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

    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });

    await expect(
      fetchUrl.handler({ url: "https://example.com/down" }, stubService()),
    ).rejects.toThrow("Fetch failed: 503");
  });

  it("sends Chrome-like browser headers on the first attempt", async () => {
    const tools = createWebTools(undefined, undefined);
    const fetchUrl = tools[2]!;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "text/plain"]]),
      text: async () => "ok",
    });

    await fetchUrl.handler({ url: "https://example.com/page" }, stubService());

    const headers = fetchCall(0).headers;
    expect(headers["User-Agent"]).toMatch(/Chrome\/\d+/);
    expect(headers["sec-ch-ua"]).toContain("Chromium");
    expect(headers["sec-ch-ua-mobile"]).toBe("?0");
    expect(headers["sec-ch-ua-platform"]).toBe('"Linux"');
    expect(headers["Sec-Fetch-Site"]).toBe("none");
    expect(headers["Sec-Fetch-Mode"]).toBe("navigate");
    expect(headers["Sec-Fetch-Dest"]).toBe("document");
    expect(headers["Upgrade-Insecure-Requests"]).toBe("1");
    expect(headers.Accept).toContain("text/html");
    expect(headers["Accept-Language"]).toBe("en-US,en;q=0.9");
    // First attempt is a typed-URL navigation — no Referer.
    expect(headers.Referer).toBeUndefined();
  });

  it("retries 403 with a Referer and cross-site Sec-Fetch-Site", async () => {
    const tools = createWebTools(undefined, undefined);
    const fetchUrl = tools[2]!;

    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "text/plain"]]),
        text: async () => "got through",
      });

    const result = await fetchUrl.handler({ url: "https://example.com/article" }, stubService());
    expect(result).toBe("got through");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstHeaders = fetchCall(0).headers;
    const retryHeaders = fetchCall(1).headers;

    expect(firstHeaders.Referer).toBeUndefined();
    expect(firstHeaders["Sec-Fetch-Site"]).toBe("none");

    expect(retryHeaders.Referer).toBe("https://example.com/");
    expect(retryHeaders["Sec-Fetch-Site"]).toBe("cross-site");
    // UA must NOT change across retries — UA churn is a bot signal.
    expect(retryHeaders["User-Agent"]).toBe(firstHeaders["User-Agent"]);
  });

  it("retries 429 (rate limited)", async () => {
    const tools = createWebTools(undefined, undefined);
    const fetchUrl = tools[2]!;

    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: "Too Many Requests" })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "text/plain"]]),
        text: async () => "ok",
      });

    const result = await fetchUrl.handler({ url: "https://example.com/foo" }, stubService());
    expect(result).toBe("ok");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to Tavily Extract when direct fetch is bot-blocked", async () => {
    const tools = createWebTools("tavily-key", undefined);
    const fetchUrl = tools[2]!;

    // 3 direct attempts all return 403 → withRetry exhausts → fallback fires.
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "https://walled.example.com/page") {
        return { ok: false, status: 403, statusText: "Forbidden" };
      }
      if (url === "https://api.tavily.com/extract") {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                url: "https://walled.example.com/page",
                raw_content: "# Real content\n\nExtracted via Tavily.",
              },
            ],
            failed_results: [],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchUrl.handler(
      { url: "https://walled.example.com/page" },
      stubService(),
    );
    expect(result).toContain("Extracted via Tavily");

    // 3 direct attempts (1 + 2 retries) + 1 Tavily call.
    const tavilyIdx = mockFetch.mock.calls.findIndex(
      (c) => c[0] === "https://api.tavily.com/extract",
    );
    expect(tavilyIdx).toBeGreaterThanOrEqual(0);
    const tavilyBody = TavilyExtractBodySchema.parse(JSON.parse(fetchCall(tavilyIdx).body));
    expect(tavilyBody.urls).toBe("https://walled.example.com/page");
    expect(tavilyBody.extract_depth).toBe("basic");
  });

  it("does NOT fall back to Tavily on a 404", async () => {
    const tools = createWebTools("tavily-key", undefined);
    const fetchUrl = tools[2]!;

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    await expect(
      fetchUrl.handler({ url: "https://example.com/missing" }, stubService()),
    ).rejects.toThrow("404");

    // Tavily must not have been called — 404 means the page doesn't
    // exist, not a bot block.
    expect(mockFetch.mock.calls.some((c) => c[0] === "https://api.tavily.com/extract")).toBe(false);
  });

  it("does NOT fall back when Tavily key is not configured", async () => {
    const tools = createWebTools(undefined, undefined);
    const fetchUrl = tools[2]!;

    mockFetch.mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" });

    await expect(
      fetchUrl.handler({ url: "https://walled.example.com/page" }, stubService()),
    ).rejects.toThrow("403");
  });

  it("falls back to Tavily Extract on a connection timeout", async () => {
    // Bot defences sometimes drop the connection rather than return an
    // HTTP status — fetch throws a DOMException("TimeoutError") in that
    // case. The fallback must still kick in: a 200/markdown answer from
    // Tavily, not a re-thrown timeout.
    const tools = createWebTools("tavily-key", undefined);
    const fetchUrl = tools[2]!;

    mockFetch.mockImplementation(async (url: string) => {
      if (url === "https://walled.example.com/page") {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      if (url === "https://api.tavily.com/extract") {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                url: "https://walled.example.com/page",
                raw_content: "Got via Tavily despite timeout.",
              },
            ],
            failed_results: [],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchUrl.handler(
      { url: "https://walled.example.com/page" },
      stubService(),
    );
    expect(result).toContain("despite timeout");
    expect(mockFetch.mock.calls.some((c) => c[0] === "https://api.tavily.com/extract")).toBe(true);
  });

  it("surfaces both errors when direct fetch and Tavily both fail", async () => {
    const tools = createWebTools("tavily-key", undefined);
    const fetchUrl = tools[2]!;

    mockFetch.mockImplementation(async (url: string) => {
      if (url === "https://api.tavily.com/extract") {
        return {
          ok: true,
          json: async () => ({
            results: [],
            failed_results: [
              { url: "https://walled.example.com/page", error: "URL is not accessible" },
            ],
          }),
        };
      }
      return { ok: false, status: 403, statusText: "Forbidden" };
    });

    await expect(
      fetchUrl.handler({ url: "https://walled.example.com/page" }, stubService()),
    ).rejects.toThrow(/Direct fetch:.*403.*Tavily fallback:.*not accessible/);
  });
});
