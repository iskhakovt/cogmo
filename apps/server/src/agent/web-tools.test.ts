import { Readability } from "@mozilla/readability";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import { logger } from "../logger.js";
import { expectDefined } from "../test/assertions.js";
import type { ResolveHost } from "../util/blocked-address.js";
import type { Service } from "./service.js";
import type { ToolSpec } from "./tools.js";
import { createWebTools } from "./web-tools.js";

// Mock withRetry as a no-delay retry loop, so these tests don't pay the
// real exponential backoff. The retry mechanics themselves are covered in
// src/util/with-retry.test.ts.
//
// One detail of p-retry's contract is reproduced deliberately, because the
// rejection messages these tests assert on depend on it: an `AbortError`
// reaches the caller as its `originalError`, NOT as itself. p-retry
// constructs that from the message when the abort was built from a string,
// so the class is lost and `instanceof AbortError` is false downstream.
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
          if (e instanceof actual.AbortError) {
            throw (e as { originalError?: unknown }).originalError ?? e;
          }
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
type FetchInit = {
  headers?: Record<string, string>;
  body?: string;
  method?: string;
  redirect?: string;
};
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

/** A resolver answering every name with `addresses`. */
function resolvesTo(...addresses: Array<{ address: string; family: number }>): ResolveHost {
  return async () => addresses;
}

const publicHost = resolvesTo({ address: "93.184.215.14", family: 4 });

/**
 * `fetch_url` with an injected resolver. Every test passes one, so none of
 * them depends on real DNS answering for the hosts it names.
 */
function fetchUrlTool(tavilyKey: string | undefined, resolveHost: ResolveHost): ToolSpec {
  return expectDefined(
    createWebTools(tavilyKey, undefined, resolveHost).find((t) => t.name === "fetch_url"),
    "fetch_url",
  );
}

function textResponse(body: string): unknown {
  return {
    ok: true,
    status: 200,
    headers: new Map([["content-type", "text/plain"]]),
    text: async () => body,
  };
}

function redirectTo(location: string): unknown {
  return {
    ok: false,
    status: 302,
    statusText: "Found",
    headers: new Map([["location", location]]),
  };
}

const TAVILY_EXTRACT = "https://api.tavily.com/extract";

function tavilyExtracts(content: string): unknown {
  return {
    ok: true,
    json: async () => ({ results: [{ url: "https://example.com/", raw_content: content }] }),
  };
}

function eaiAgain(hostname: string): Error {
  return Object.assign(new Error(`getaddrinfo EAI_AGAIN ${hostname}`), { code: "EAI_AGAIN" });
}

/** The budget `fetch_url` gives one attempt, which the timeout tests tell apart by value. */
const ATTEMPT_BUDGET_MS = 15_000;

function fetchInit(index: number): FetchInit | undefined {
  return expectDefined(mockFetch.mock.calls[index], `fetch call ${index}`)[1];
}

describe("web_search", () => {
  it("returns formatted search results", async () => {
    const [search] = createWebTools("tavily-key", undefined, publicHost);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          { title: "Result 1", url: "https://example.com/1", content: "Snippet 1" },
          { title: "Result 2", url: "https://example.com/2", content: "Snippet 2" },
        ],
      }),
    });

    const result = (
      await search!.handler({ query: "test query", maxResults: 5 }, stubService())
    )._unsafeUnwrap();

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

  it("rejects when API key is missing", async () => {
    const [search] = createWebTools(undefined, undefined, publicHost);
    const outcome = await search!.handler({ query: "test" }, stubService());

    expect(outcome._unsafeUnwrapErr().message).toBe(
      "web_search is not configured (TAVILY_API_KEY missing).",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects on a client error (4xx) and logs it at warn", async () => {
    const [search] = createWebTools("key", undefined, publicHost);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, text: async () => "rate limited" });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const outcome = await search!.handler({ query: "test" }, stubService());

    expect(outcome._unsafeUnwrapErr().message).toBe(
      "web_search failed: Tavily API error: 429 rate limited",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "web_search" }),
      "web tool upstream request failed",
    );
    warn.mockRestore();
  });

  it("rejects on a server error (5xx) after the retry budget", async () => {
    const [search] = createWebTools("key", undefined, publicHost);
    mockFetch.mockResolvedValue({ ok: false, status: 503, text: async () => "down" });

    const outcome = await search!.handler({ query: "test" }, stubService());

    expect(outcome._unsafeUnwrapErr().message).toBe(
      "web_search failed: Tavily API server error: 503 down",
    );
  });

  it("handles empty results", async () => {
    const [search] = createWebTools("key", undefined, publicHost);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });

    const result = (await search!.handler({ query: "obscure" }, stubService()))._unsafeUnwrap();
    expect(result).toBe("No results found.");
  });
});

describe("web_answer", () => {
  it("returns answer with citations", async () => {
    const tools = createWebTools(undefined, "or-key", publicHost);
    const answer = tools[1]!;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "The answer is 42." } }],
        citations: ["https://source.com/1", "https://source.com/2"],
      }),
    });

    const result = (
      await answer.handler({ question: "meaning of life" }, stubService())
    )._unsafeUnwrap();

    expect(result).toContain("The answer is 42.");
    expect(result).toContain("Sources:");
    expect(result).toContain("https://source.com/1");

    const body = OpenRouterRequestBodySchema.parse(JSON.parse(fetchCall(0).body));
    expect(body.model).toBe("perplexity/sonar");
  });

  it("returns answer without citations when none provided", async () => {
    const tools = createWebTools(undefined, "or-key", publicHost);
    const answer = tools[1]!;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Just an answer." } }],
      }),
    });

    const result = (await answer.handler({ question: "test" }, stubService()))._unsafeUnwrap();
    expect(result).toBe("Just an answer.");
    expect(result).not.toContain("Sources:");
  });

  it("rejects when API key is missing", async () => {
    const tools = createWebTools(undefined, undefined, publicHost);
    const answer = tools[1]!;
    const outcome = await answer.handler({ question: "test" }, stubService());

    expect(outcome._unsafeUnwrapErr().message).toBe(
      "web_answer is not configured (OPENROUTER_API_KEY missing).",
    );
  });

  it("rejects on a server error (5xx) after the retry budget", async () => {
    const tools = createWebTools(undefined, "or-key", publicHost);
    const answer = tools[1]!;
    mockFetch.mockResolvedValue({ ok: false, status: 502, text: async () => "bad gateway" });

    const outcome = await answer.handler({ question: "test" }, stubService());

    expect(outcome._unsafeUnwrapErr().message).toBe(
      "web_answer failed: OpenRouter API server error: 502 bad gateway",
    );
  });

  it("rejects on a client error (4xx)", async () => {
    const tools = createWebTools(undefined, "or-key", publicHost);
    const answer = tools[1]!;
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "unauthorized" });

    const outcome = await answer.handler({ question: "test" }, stubService());

    expect(outcome._unsafeUnwrapErr().message).toBe(
      "web_answer failed: OpenRouter API error: 401 unauthorized",
    );
  });

  it("falls back to a placeholder when the model returns null content", async () => {
    const tools = createWebTools(undefined, "or-key", publicHost);
    const answer = tools[1]!;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: null } }] }),
    });

    const result = (await answer.handler({ question: "test" }, stubService()))._unsafeUnwrap();

    expect(result).toBe("No answer returned.");
  });
});

describe("fetch_url", () => {
  it("extracts article content from HTML", async () => {
    const fetchUrl = fetchUrlTool(undefined, publicHost);

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

    const result = (
      await fetchUrl.handler({ url: "https://example.com/article" }, stubService())
    )._unsafeUnwrap();
    expect(result).toContain("main content");
  });

  it("returns raw text for non-HTML", async () => {
    const fetchUrl = fetchUrlTool(undefined, publicHost);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "text/plain"]]),
      text: async () => "Plain text content",
    });

    const result = (
      await fetchUrl.handler({ url: "https://example.com/file.txt" }, stubService())
    )._unsafeUnwrap();
    expect(result).toBe("Plain text content");
  });

  it("rejects private IPs", async () => {
    const fetchUrl = fetchUrlTool(undefined, resolvesTo({ address: "127.0.0.1", family: 4 }));

    const privateIp = await fetchUrl.handler({ url: "https://192.168.1.1/secret" }, stubService());
    expect(privateIp._unsafeUnwrapErr().message).toContain("private/internal");

    const localhost = await fetchUrl.handler({ url: "https://localhost/api" }, stubService());
    expect(localhost._unsafeUnwrapErr().message).toContain("private/internal");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["127.0.0.1", 4],
    ["10.0.0.5", 4],
    ["169.254.169.254", 4],
    ["::1", 6],
    ["fd00::1", 6],
    ["ff02::1", 6],
  ])("refuses a hostname resolving to %s", async (address, family) => {
    mockFetch.mockResolvedValue(textResponse("internal data"));
    const fetchUrl = fetchUrlTool(undefined, resolvesTo({ address, family }));

    const outcome = await fetchUrl.handler(
      { url: "https://looks-public.example/x" },
      stubService(),
    );

    expect(outcome._unsafeUnwrapErr().message).toContain("private/internal");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("names the host but not the internal address it resolved to, which goes to the log", async () => {
    mockFetch.mockResolvedValue(textResponse("internal data"));
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    try {
      const fetchUrl = fetchUrlTool(
        undefined,
        resolvesTo({ address: "93.184.215.14", family: 4 }, { address: "10.0.0.5", family: 4 }),
      );

      const outcome = await fetchUrl.handler({ url: "https://split.example/x" }, stubService());

      const message = outcome._unsafeUnwrapErr().message;
      expect(message).toContain("split.example");
      expect(message).not.toContain("10.0.0.5");
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ host: "split.example", address: "10.0.0.5" }),
        expect.any(String),
      );
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  it("fetches a host resolving beside a reserved /24 in an otherwise public /16", async () => {
    // wordpress.com answers from 192.0.78.0/24, next to 192.0.0.0/24.
    mockFetch.mockResolvedValue(textResponse("blog"));
    const fetchUrl = fetchUrlTool(undefined, resolvesTo({ address: "192.0.78.9", family: 4 }));

    const result = (
      await fetchUrl.handler({ url: "https://wordpress.com/" }, stubService())
    )._unsafeUnwrap();

    expect(result).toBe("blog");
  });

  it.each([
    ["http://169.254.169.254/latest/meta-data/"],
    ["http://127.0.0.2/"],
    ["http://100.64.0.1/"],
    ["http://[::1]:8080/"],
    ["http://[::ffff:127.0.0.1]/"],
    ["http://[fd00::1]/"],
  ])("refuses the IP literal %s without resolving it", async (url) => {
    mockFetch.mockResolvedValue(textResponse("internal data"));
    const resolveHost = vi.fn(publicHost);
    const fetchUrl = fetchUrlTool(undefined, resolveHost);

    const outcome = await fetchUrl.handler({ url }, stubService());

    expect(outcome._unsafeUnwrapErr().message).toContain("private/internal");
    expect(resolveHost).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("follows a redirect to a public host, checking it first", async () => {
    mockFetch
      .mockResolvedValueOnce(redirectTo("https://cdn.example/final"))
      .mockResolvedValueOnce(textResponse("landed"));
    const resolveHost = vi.fn(publicHost);
    const fetchUrl = fetchUrlTool(undefined, resolveHost);

    const result = (
      await fetchUrl.handler({ url: "https://example.com/start" }, stubService())
    )._unsafeUnwrap();

    expect(result).toBe("landed");
    expect(fetchCall(1).url).toBe("https://cdn.example/final");
    expect(resolveHost.mock.calls).toEqual([["example.com"], ["cdn.example"]]);
    // Followed here rather than by `fetch`, which would skip the check.
    expect(fetchInit(0)?.redirect).toBe("manual");
    expect(fetchInit(1)?.redirect).toBe("manual");
  });

  it("refuses a redirect to a private address and does not fall back to Tavily", async () => {
    mockFetch.mockResolvedValue(redirectTo("http://127.0.0.1:8888/admin"));
    const fetchUrl = fetchUrlTool("tavily-key", publicHost);

    const outcome = await fetchUrl.handler({ url: "https://example.com/start" }, stubService());

    expect(outcome._unsafeUnwrapErr().message).toContain("private/internal");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("gives up on a redirect chain longer than its hop cap, without retrying it", async () => {
    mockFetch.mockResolvedValue(redirectTo("/again"));
    const fetchUrl = fetchUrlTool(undefined, publicHost);

    const outcome = await fetchUrl.handler({ url: "https://example.com/loop" }, stubService());

    expect(outcome._unsafeUnwrapErr().message).toMatch(/redirects/);
    expect(mockFetch).toHaveBeenCalledTimes(11);
  });

  it.each([
    // A cookie wall: `302 Location: /article` plus a cookie, repeating,
    // since `fetch` keeps no cookie jar.
    ["/article"],
    ["http://[oops"],
  ])("hands a redirect to %s it cannot follow to Tavily", async (location) => {
    mockFetch.mockImplementation(async (url: string) =>
      url === TAVILY_EXTRACT ? tavilyExtracts("the article") : redirectTo(location),
    );
    const fetchUrl = fetchUrlTool("tavily-key", publicHost);

    const result = (
      await fetchUrl.handler({ url: "https://example.com/article" }, stubService())
    )._unsafeUnwrap();

    expect(result).toBe("the article");
  });

  it("does not hand a redirect to a non-http scheme to Tavily", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      url === TAVILY_EXTRACT ? tavilyExtracts("unreachable") : redirectTo("file:///etc/passwd"),
    );
    const fetchUrl = fetchUrlTool("tavily-key", publicHost);

    const outcome = await fetchUrl.handler({ url: "https://example.com/start" }, stubService());

    expect(outcome._unsafeUnwrapErr().message).toBe("Unsupported protocol: file:");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("ends a redirect status with no Location as permanent, without Tavily", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      url === TAVILY_EXTRACT
        ? tavilyExtracts("unreachable")
        : // `Headers`, not a `Map`: a missing header reads as `null`, not `undefined`.
          { ok: false, status: 302, statusText: "Found", headers: new Headers() },
    );
    const fetchUrl = fetchUrlTool("tavily-key", publicHost);

    const outcome = await fetchUrl.handler({ url: "https://example.com/start" }, stubService());

    expect(outcome._unsafeUnwrapErr().message).toBe("Fetch failed: 302 Found");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries a resolver that is briefly unavailable", async () => {
    mockFetch.mockResolvedValue(textResponse("recovered"));
    const resolveHost = vi
      .fn<ResolveHost>()
      .mockRejectedValueOnce(eaiAgain("example.com"))
      .mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
    const fetchUrl = fetchUrlTool(undefined, resolveHost);

    const result = (
      await fetchUrl.handler({ url: "https://example.com/x" }, stubService())
    )._unsafeUnwrap();

    expect(result).toBe("recovered");
    expect(resolveHost).toHaveBeenCalledTimes(2);
  });

  it("ends on the last attempt's failure, not an earlier attempt's lookup", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable" });
    const resolveHost = vi
      .fn<ResolveHost>()
      .mockRejectedValueOnce(eaiAgain("example.com"))
      .mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
    const fetchUrl = fetchUrlTool(undefined, resolveHost);

    const outcome = await fetchUrl.handler({ url: "https://example.com/x" }, stubService());

    expect(outcome._unsafeUnwrapErr().message).toBe("Fetch failed: 503 Service Unavailable");
  });

  it("reports a resolver that stays unavailable as unresolvable, without Tavily", async () => {
    const resolveHost = vi.fn<ResolveHost>().mockRejectedValue(eaiAgain("example.com"));
    const fetchUrl = fetchUrlTool("tavily-key", resolveHost);

    const outcome = await fetchUrl.handler({ url: "https://example.com/x" }, stubService());

    expect(outcome._unsafeUnwrapErr().message).toBe("Could not resolve example.com.");
    expect(resolveHost).toHaveBeenCalledTimes(3);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses a host that does not resolve, once, without handing the URL to Tavily", async () => {
    // A name only the local network knows: Tavily would receive the full
    // URL, query string included, and could not resolve it either.
    const resolveHost = vi.fn<ResolveHost>(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND printer.local"), { code: "ENOTFOUND" });
    });
    const fetchUrl = fetchUrlTool("tavily-key", resolveHost);

    const outcome = await fetchUrl.handler(
      { url: "http://printer.local/status?token=secret" },
      stubService(),
    );

    expect(outcome._unsafeUnwrapErr().message).toBe("Could not resolve printer.local.");
    expect(resolveHost).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("retries a lookup that outlasts its own timeout, then reports the host unresolvable", async () => {
    // `dns.lookup` takes no signal. The per-lookup timeout, shortened here,
    // ends the wait; the attempt's 15s budget is left long.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const shortened = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => timeout(ms === ATTEMPT_BUDGET_MS ? 60_000 : 20));
    try {
      const resolveHost = vi.fn<ResolveHost>(() => new Promise(() => {}));
      const fetchUrl = fetchUrlTool("tavily-key", resolveHost);

      const outcome = await fetchUrl.handler({ url: "https://hung-dns.example/x" }, stubService());

      expect(outcome._unsafeUnwrapErr().message).toBe("Could not resolve hung-dns.example.");
      expect(resolveHost).toHaveBeenCalledTimes(3);
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      shortened.mockRestore();
    }
  });

  it("reports the attempt's budget running out during a later hop's lookup as a timeout", async () => {
    const budget = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const controlled = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => (ms === ATTEMPT_BUDGET_MS ? budget.signal : timeout(60_000)));
    try {
      mockFetch.mockResolvedValue(redirectTo("https://cdn.example/final"));
      const fetchUrl = fetchUrlTool(undefined, async (hostname) => {
        if (hostname !== "cdn.example") return [{ address: "93.184.215.14", family: 4 }];
        budget.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        return new Promise<never>(() => {});
      });

      const outcome = await fetchUrl.handler({ url: "https://example.com/x" }, stubService());

      const message = outcome._unsafeUnwrapErr().message;
      expect(message).toMatch(/timeout/);
      expect(message).not.toContain("Could not resolve");
    } finally {
      controlled.mockRestore();
    }
  });

  it("falls back to Tavily Extract when article extraction throws", async () => {
    const parse = vi.spyOn(Readability.prototype, "parse").mockImplementation(() => {
      throw new Error("readability failed");
    });
    try {
      mockFetch.mockImplementation(async (url: string) =>
        url === TAVILY_EXTRACT
          ? tavilyExtracts("via Tavily")
          : {
              ok: true,
              status: 200,
              headers: new Map([["content-type", "text/html"]]),
              text: async () => "<html><body><p>page</p></body></html>",
            },
      );
      const fetchUrl = fetchUrlTool("tavily-key", publicHost);

      const result = (
        await fetchUrl.handler({ url: "https://example.com/page" }, stubService())
      )._unsafeUnwrap();

      expect(result).toBe("via Tavily");
    } finally {
      parse.mockRestore();
    }
  });

  it("falls back to Tavily Extract when the body fails mid-read", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      url === TAVILY_EXTRACT
        ? tavilyExtracts("via Tavily")
        : {
            ok: true,
            status: 200,
            headers: new Map([["content-type", "text/plain"]]),
            text: async () => {
              throw new TypeError("terminated");
            },
          },
    );
    const fetchUrl = fetchUrlTool("tavily-key", publicHost);

    const result = (
      await fetchUrl.handler({ url: "https://example.com/page" }, stubService())
    )._unsafeUnwrap();

    expect(result).toBe("via Tavily");
  });

  it("rejects non-http protocols", async () => {
    const fetchUrl = fetchUrlTool(undefined, publicHost);

    const outcome = await fetchUrl.handler({ url: "file:///etc/passwd" }, stubService());
    expect(outcome._unsafeUnwrapErr().message).toBe("Unsupported protocol: file:");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("truncates large content", async () => {
    const fetchUrl = fetchUrlTool(undefined, publicHost);

    const largeContent = "x".repeat(60_000);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "text/plain"]]),
      text: async () => largeContent,
    });

    const result = (
      await fetchUrl.handler({ url: "https://example.com/big" }, stubService())
    )._unsafeUnwrap();
    expect(result).toContain("[Content truncated");
    expect(result.length).toBeLessThan(60_000);
  });

  it("rejects on HTTP errors", async () => {
    const fetchUrl = fetchUrlTool(undefined, publicHost);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    const outcome = await fetchUrl.handler({ url: "https://example.com/missing" }, stubService());
    expect(outcome._unsafeUnwrapErr().message).toBe("Fetch failed: 404 Not Found");
  });

  it("rejects on server error (5xx) after the retry budget", async () => {
    const fetchUrl = fetchUrlTool(undefined, publicHost);

    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });

    const outcome = await fetchUrl.handler({ url: "https://example.com/down" }, stubService());
    expect(outcome._unsafeUnwrapErr().message).toBe("Fetch failed: 503 Service Unavailable");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("sends Chrome-like browser headers on the first attempt", async () => {
    const fetchUrl = fetchUrlTool(undefined, publicHost);

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
    const fetchUrl = fetchUrlTool(undefined, publicHost);

    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "text/plain"]]),
        text: async () => "got through",
      });

    const result = (
      await fetchUrl.handler({ url: "https://example.com/article" }, stubService())
    )._unsafeUnwrap();
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
    const fetchUrl = fetchUrlTool(undefined, publicHost);

    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: "Too Many Requests" })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "text/plain"]]),
        text: async () => "ok",
      });

    const result = (
      await fetchUrl.handler({ url: "https://example.com/foo" }, stubService())
    )._unsafeUnwrap();
    expect(result).toBe("ok");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to Tavily Extract when direct fetch is bot-blocked", async () => {
    const fetchUrl = fetchUrlTool("tavily-key", publicHost);

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

    const result = (
      await fetchUrl.handler({ url: "https://walled.example.com/page" }, stubService())
    )._unsafeUnwrap();
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
    const fetchUrl = fetchUrlTool("tavily-key", publicHost);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    const outcome = await fetchUrl.handler({ url: "https://example.com/missing" }, stubService());
    expect(outcome._unsafeUnwrapErr().message).toBe("Fetch failed: 404 Not Found");

    // Tavily must not have been called — 404 means the page doesn't
    // exist, not a bot block.
    expect(mockFetch.mock.calls.some((c) => c[0] === "https://api.tavily.com/extract")).toBe(false);
  });

  it("does NOT fall back when Tavily key is not configured", async () => {
    const fetchUrl = fetchUrlTool(undefined, publicHost);

    mockFetch.mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" });

    const outcome = await fetchUrl.handler(
      { url: "https://walled.example.com/page" },
      stubService(),
    );
    expect(outcome._unsafeUnwrapErr().message).toBe("Fetch failed: 403 Forbidden");
  });

  it("falls back to Tavily Extract on a connection timeout", async () => {
    // Bot defences sometimes drop the connection rather than return an
    // HTTP status — fetch throws a DOMException("TimeoutError") in that
    // case. The fallback must still kick in: a 200/markdown answer from
    // Tavily, not a re-thrown timeout.
    const fetchUrl = fetchUrlTool("tavily-key", publicHost);

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

    const result = (
      await fetchUrl.handler({ url: "https://walled.example.com/page" }, stubService())
    )._unsafeUnwrap();
    expect(result).toContain("despite timeout");
    expect(mockFetch.mock.calls.some((c) => c[0] === "https://api.tavily.com/extract")).toBe(true);
  });

  it("surfaces both errors when direct fetch and Tavily both fail", async () => {
    const fetchUrl = fetchUrlTool("tavily-key", publicHost);

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

    const outcome = await fetchUrl.handler(
      { url: "https://walled.example.com/page" },
      stubService(),
    );
    expect(outcome._unsafeUnwrapErr().message).toMatch(
      /Direct fetch:.*403.*Tavily fallback:.*not accessible/,
    );
  });

  it("rejects with both errors when Tavily Extract itself fails upstream", async () => {
    const fetchUrl = fetchUrlTool("tavily-key", publicHost);

    mockFetch.mockImplementation(async (url: string) => {
      if (url === "https://api.tavily.com/extract") {
        return { ok: false, status: 432, text: async () => "plan limit exceeded" };
      }
      return { ok: false, status: 403, statusText: "Forbidden" };
    });

    const outcome = await fetchUrl.handler(
      { url: "https://walled.example.com/page" },
      stubService(),
    );
    expect(outcome._unsafeUnwrapErr().message).toBe(
      "Failed to fetch URL. Direct fetch: Fetch failed: 403 Forbidden. Tavily fallback: Tavily Extract error: 432 plan limit exceeded",
    );
  });
});
