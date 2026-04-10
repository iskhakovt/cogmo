import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { z } from "zod";
import { AbortError, withRetry } from "../util/with-retry.js";
import type { ToolSpec } from "./tools.js";
import { defineTool } from "./tools.js";

const MAX_CONTENT_LENGTH = 50_000;

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

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
  return [createWebSearch(tavilyApiKey), createWebAnswer(openRouterApiKey), createFetchUrl()];
}

// --- web_search (Tavily) ---

function createWebSearch(apiKey: string | undefined): ToolSpec {
  return defineTool({
    name: "web_search",
    description:
      "Search the web for current information. Returns titles, URLs, and snippets. " +
      "Use this when you need to find facts, recent events, or multiple sources to compare.",
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
            throw new Error(`Tavily API server error: ${r.status} ${await r.text()}`);
          }
          if (!r.ok) {
            throw new AbortError(`Tavily API error: ${r.status} ${await r.text()}`);
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
            throw new Error(`OpenRouter API server error: ${r.status} ${await r.text()}`);
          }
          if (!r.ok) {
            throw new AbortError(`OpenRouter API error: ${r.status} ${await r.text()}`);
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

function createFetchUrl(): ToolSpec {
  return defineTool({
    name: "fetch_url",
    description:
      "Fetch and extract the main content from a URL. " +
      "Returns cleaned article text for web pages, or raw text for non-HTML content. " +
      "Use this when you need to read a specific web page.",
    schema: z.object({
      url: z.string().url().describe("The URL to fetch (http or https only)"),
    }),
    handler: async (input) => {
      validateUrl(input.url);

      const res = await withRetry(
        async () => {
          const r = await fetch(input.url, {
            headers: BROWSER_HEADERS,
            redirect: "follow",
            signal: AbortSignal.timeout(15_000),
          });
          if (r.status >= 500) {
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
          context: `fetch_url ${new URL(input.url).hostname}`,
        },
      );

      const contentType = res.headers.get("content-type") ?? "";
      const body = await res.text();

      let content: string;
      if (contentType.includes("text/html")) {
        content = extractArticle(body, input.url);
      } else {
        content = body;
      }

      if (content.length > MAX_CONTENT_LENGTH) {
        content = `${content.slice(0, MAX_CONTENT_LENGTH)}\n\n[Content truncated at ${MAX_CONTENT_LENGTH} characters]`;
      }

      return content || "No content could be extracted from this URL.";
    },
  });
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
