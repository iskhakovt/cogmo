import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { z } from "zod";
import { logger } from "../logger.js";
import { AbortError, withRetry } from "../util/with-retry.js";
import type { ToolSpec } from "./tools.js";
import { defineTool } from "./tools.js";

const MAX_CONTENT_LENGTH = 50_000;

// Chrome desktop navigation headers. Together these defeat the cheap
// "is this curl/undici/python-requests?" filters used by Cloudflare's
// default rules, Akamai, and most CDN bot blockers. They will NOT beat
// Cloudflare Turnstile or strict JA4 TLS-fingerprint filters — those
// require a real browser or curl-impersonate, which we don't take on
// for a one-shot fetch tool.
//
// Pin User-Agent and sec-ch-ua-platform together — a UA that says Linux
// with a sec-ch-ua-platform of "Windows" is itself a bot signal. Bump
// CHROME_MAJOR every few months; real Chrome's UA leaves the patch
// fields as `.0.0.0`.
const CHROME_MAJOR = "138";

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
  // User-Agent Client Hints — Chrome sends these unconditionally on https.
  // The "Not A;Brand" entry is GREASE so servers can't hardcode the list.
  "sec-ch-ua": `"Chromium";v="${CHROME_MAJOR}", "Not A(Brand";v="24", "Google Chrome";v="${CHROME_MAJOR}"`,
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  // Fetch-metadata: top-level navigation from a typed URL (no referrer).
  // Missing these is a strong bot signal.
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-User": "?1",
  "Sec-Fetch-Dest": "document",
  "Upgrade-Insecure-Requests": "1",
  // Exact Chrome navigation Accept value — the q-values and order are part
  // of the fingerprint, don't reformat. Sending `*/*` (undici default) is
  // an instant tell.
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
  // gzip/deflate/br only — undici decompresses these natively. zstd is
  // what Chrome advertises now but support varies across Node releases,
  // so we skip it to avoid garbled bodies.
  "Accept-Encoding": "gzip, deflate, br",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Headers for the second attempt after a 403/429. Adds a same-origin
 * `Referer` and flips `Sec-Fetch-Site` to `cross-site`, which sometimes
 * turns a "no-referer = bot" rejection into a 200. Crucially we do NOT
 * change the User-Agent — UA churn across retries is itself a bot
 * signal (and we have no IP to pair it with).
 */
function retryHeaders(targetUrl: string): Record<string, string> {
  return {
    ...BROWSER_HEADERS,
    "Sec-Fetch-Site": "cross-site",
    Referer: `${new URL(targetUrl).origin}/`,
  };
}

/**
 * Create web tools (search, answer, fetch) with injected API keys.
 *
 * Keys are optional — tools return a helpful error if the key is missing.
 * This keeps the tools registered (LLM sees them) so it can explain
 * why a capability is unavailable rather than silently lacking it.
 */
export function createWebTools(
  tavilyApiKey: string | undefined,
  openRouterApiKey: string | undefined,
): ToolSpec[] {
  return [
    createWebSearch(tavilyApiKey),
    createWebAnswer(openRouterApiKey),
    createFetchUrl(tavilyApiKey),
  ];
}

// --- web_search (Tavily) ---

function createWebSearch(apiKey: string | undefined): ToolSpec {
  return defineTool({
    name: "web_search",
    description:
      "Search the web for current information. Returns titles, URLs, and snippets. " +
      "Use this when you need to find facts, recent events, or multiple sources to compare.",
    parallelSafe: true,
    schema: z.object({
      query: z.string().describe("Search query"),
      maxResults: z
        .number()
        .min(1)
        .max(20)
        .default(5)
        .describe("Maximum number of results to return"),
    }),
    handler: async (input) => {
      if (!apiKey) return "Error: web_search is not configured (TAVILY_API_KEY missing).";

      const res = await withRetry(
        async () => {
          const r = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              query: input.query,
              max_results: input.maxResults,
              include_raw_content: false,
            }),
          });
          if (r.status >= 500) {
            throw new Error(
              `Tavily API server error: ${r.status} ${(await r.text()).slice(0, 200)}`,
            );
          }
          if (!r.ok) {
            throw new AbortError(`Tavily API error: ${r.status} ${(await r.text()).slice(0, 200)}`);
          }
          return r;
        },
        // retries: 2 — external rate-limited API, don't hammer.
        { retries: 2, context: "tavily.search" },
      );

      const data = (await res.json()) as {
        results: Array<{ title: string; url: string; content: string }>;
      };

      if (data.results.length === 0) return "No results found.";

      return data.results.map((r) => `[${r.title}](${r.url})\n${r.content}`).join("\n\n");
    },
  });
}

// --- web_answer (Perplexity Sonar via OpenRouter) ---

function createWebAnswer(apiKey: string | undefined): ToolSpec {
  return defineTool({
    name: "web_answer",
    description:
      "Get a synthesized answer to a question using web search with AI reasoning. " +
      "Returns a direct answer with citations. Use this for factual questions, " +
      "current events, or when you need a concise researched answer rather than raw search results.",
    // Durable: Perplexity Sonar via OpenRouter is a billable LLM round-trip.
    // `web_search` (Tavily) and `fetch_url` are cheaper and stay non-durable —
    // wasted retries there are acceptable.
    durable: true,
    parallelSafe: true,
    schema: z.object({
      question: z.string().describe("The question to answer"),
    }),
    handler: async (input) => {
      if (!apiKey) return "Error: web_answer is not configured (OPENROUTER_API_KEY missing).";

      const res = await withRetry(
        async () => {
          const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: "perplexity/sonar",
              messages: [{ role: "user", content: input.question }],
            }),
          });
          if (r.status >= 500) {
            throw new Error(
              `OpenRouter API server error: ${r.status} ${(await r.text()).slice(0, 200)}`,
            );
          }
          if (!r.ok) {
            throw new AbortError(
              `OpenRouter API error: ${r.status} ${(await r.text()).slice(0, 200)}`,
            );
          }
          return r;
        },
        // retries: 2 — external rate-limited API, don't hammer.
        { retries: 2, context: "openrouter.sonar" },
      );

      const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
        citations?: string[];
      };

      const answer = data.choices[0]?.message.content ?? "No answer returned.";
      const citations = data.citations;

      if (citations && citations.length > 0) {
        return `${answer}\n\nSources:\n${citations.map((c) => `- ${c}`).join("\n")}`;
      }
      return answer;
    },
  });
}

// --- fetch_url ---

function createFetchUrl(tavilyApiKey: string | undefined): ToolSpec {
  return defineTool({
    name: "fetch_url",
    description:
      "Fetch and extract the main content from a URL. " +
      "Returns cleaned article text for web pages, or raw text for non-HTML content. " +
      "Use this when you need to read a specific web page.",
    parallelSafe: true,
    schema: z.object({
      url: z.string().url().describe("The URL to fetch (http or https only)"),
    }),
    handler: async (input) => {
      validateUrl(input.url);

      let content: string;
      try {
        content = await directFetch(input.url);
      } catch (e) {
        // Fall back to Tavily Extract when the failure looks like a bot
        // block (403/429 after our retry-with-Referer round, or a 503
        // / network timeout that often indicates an anti-bot WAF).
        // Permanent failures like 404 / 401 propagate as-is — Tavily
        // can't conjure pages that don't exist or unauthenticated ones.
        if (!tavilyApiKey || !looksLikeBotBlock(e)) throw e;
        const errMsg = e instanceof Error ? e.message : String(e);
        logger.info(
          { url: new URL(input.url).hostname, originalError: errMsg },
          "fetch_url falling back to Tavily Extract",
        );
        content = await tavilyExtract(input.url, tavilyApiKey, errMsg);
      }

      if (content.length > MAX_CONTENT_LENGTH) {
        content = `${content.slice(0, MAX_CONTENT_LENGTH)}\n\n[Content truncated at ${MAX_CONTENT_LENGTH} characters]`;
      }

      return content || "No content could be extracted from this URL.";
    },
  });
}

async function directFetch(url: string): Promise<string> {
  let attempt = 0;
  const res = await withRetry(
    async () => {
      attempt += 1;
      // First attempt looks like a typed-URL navigation. Subsequent
      // attempts add a same-origin Referer + flip Sec-Fetch-Site to
      // cross-site — some bot filters reject only no-referer hits.
      const headers = attempt === 1 ? BROWSER_HEADERS : retryHeaders(url);
      const r = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      // 403/429 are retryable here: many bot filters return them on
      // a no-referer first hit and let the retry-with-Referer
      // through. 5xx is the usual transient-server case. Other 4xx
      // (404, 401, etc.) are permanent — abort.
      if (r.status >= 500 || r.status === 403 || r.status === 429) {
        throw new Error(`Fetch failed: ${r.status} ${r.statusText}`);
      }
      if (!r.ok) {
        throw new AbortError(`Fetch failed: ${r.status} ${r.statusText}`);
      }
      return r;
    },
    // retries: 2 — fetch_url is user-facing through the agent, cap
    // total wall-clock at 20s so a slow upstream can't make the
    // user wait through three full 15s timeouts. Context uses only
    // the hostname so query-string secrets (api keys, signed URLs)
    // don't end up in the logs.
    {
      retries: 2,
      maxRetryTimeMs: 20_000,
      context: `fetch_url ${new URL(url).hostname}`,
    },
  );

  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();
  return contentType.includes("text/html") ? extractArticle(body, url) : body;
}

/**
 * Decide whether a `directFetch` failure is bot-block-shaped enough to
 * be worth retrying via Tavily Extract. `directFetch` already encodes
 * the dichotomy: permanent failures (404 / 401 / other non-retryable
 * 4xx) are thrown as `AbortError`, retryable failures (403 / 429 / 5xx
 * after exhausting retries, network timeouts, undici-level fetch
 * errors) are thrown as plain `Error`. Tavily can only help with the
 * latter — it can't conjure pages that don't exist or unauthenticated
 * ones, and falling back there would just burn a credit to relay the
 * same 404.
 */
function looksLikeBotBlock(error: unknown): boolean {
  return error instanceof Error && !(error instanceof AbortError);
}

interface TavilyExtractResult {
  url: string;
  raw_content: string;
}

interface TavilyExtractFailure {
  url: string;
  error: string;
}

interface TavilyExtractResponse {
  results: TavilyExtractResult[];
  failed_results?: TavilyExtractFailure[];
}

async function tavilyExtract(url: string, apiKey: string, directError: string): Promise<string> {
  const res = await withRetry(
    async () => {
      const r = await fetch("https://api.tavily.com/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          urls: url,
          extract_depth: "basic",
          format: "markdown",
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (r.status >= 500) {
        throw new Error(
          `Tavily Extract server error: ${r.status} ${(await r.text()).slice(0, 200)}`,
        );
      }
      if (!r.ok) {
        throw new AbortError(`Tavily Extract error: ${r.status} ${(await r.text()).slice(0, 200)}`);
      }
      return r;
    },
    { retries: 2, context: `tavily.extract ${new URL(url).hostname}` },
  );

  const data = (await res.json()) as TavilyExtractResponse;
  const result = data.results[0];
  if (result?.raw_content) return result.raw_content;

  const tavilyError = data.failed_results?.[0]?.error ?? "Tavily returned no content";
  // Surface both errors so the agent (and logs) know the direct path
  // failed AND the fallback failed — useful for diagnosing whether to
  // tweak headers further or accept that this site needs a real
  // browser.
  throw new Error(
    `Failed to fetch URL. Direct fetch: ${directError}. Tavily fallback: ${tavilyError}`,
  );
}

function extractArticle(html: string, url: string): string {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  return article?.textContent?.trim() ?? "";
}

function validateUrl(url: string): void {
  const parsed = new URL(url);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }

  // Reject private/internal IPs (string-level check — does not resolve DNS,
  // so a public hostname resolving to a private IP bypasses this).
  const hostname = parsed.hostname;
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    isPrivate172(hostname) ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Fetching private/internal URLs is not allowed.");
  }
}

/** 172.16.0.0/12 = 172.16.x.x through 172.31.x.x */
function isPrivate172(hostname: string): boolean {
  if (!hostname.startsWith("172.")) return false;
  const second = Number.parseInt(hostname.split(".")[1] ?? "", 10);
  return second >= 16 && second <= 31;
}
