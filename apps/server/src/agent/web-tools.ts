import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { type Err, err, ok, Result } from "neverthrow";
import { match } from "ts-pattern";
import { z } from "zod";
import { logger } from "../logger.js";
import { abortable } from "../util/abortable.js";
import { isBlockedAddress, type ResolveHost } from "../util/blocked-address.js";
import { describeError } from "../util/describe-error.js";
import { AbortError, withRetry } from "../util/with-retry.js";
import { defineTool, reject, type ToolRejection, type ToolSpec } from "./tools.js";

const MAX_CONTENT_LENGTH = 50_000;

const MAX_REDIRECTS = 10;

/** One attempt's budget, spanning resolution and every redirect hop. */
const ATTEMPT_BUDGET_MS = 15_000;

/** Under the attempt's budget, so a hung resolver is retried within it. */
const LOOKUP_TIMEOUT_MS = 5_000;

/** The statuses `fetch` itself would follow (Fetch Standard, "redirect status"). */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

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
 * Keys are optional — a tool whose key is missing rejects every call.
 * This keeps the tools registered (LLM sees them) so it can explain
 * why a capability is unavailable rather than silently lacking it.
 *
 * `resolveHost` answers `fetch_url`'s destination check.
 */
export function createWebTools(
  tavilyApiKey: string | undefined,
  openRouterApiKey: string | undefined,
  resolveHost: ResolveHost,
): ToolSpec[] {
  return [
    createWebSearch(tavilyApiKey),
    createWebAnswer(openRouterApiKey),
    createFetchUrl(tavilyApiKey, resolveHost),
  ];
}

// --- web_search (Tavily) ---

function createWebSearch(apiKey: string | undefined): ToolSpec {
  return defineTool({
    name: "web_search",
    description:
      "Search the web for current information. Returns titles, URLs, and snippets. " +
      "Use this when you need to find facts, recent events, or multiple sources to compare.",
    // Durable: a paid Tavily call. Inngest re-invokes the function at every
    // step boundary, so a non-durable handler re-bills once per boundary
    // after it — not just on retry.
    durable: true,
    parallelSafe: true,
    sideEffectful: false,
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
      if (!apiKey) return reject("web_search is not configured (TAVILY_API_KEY missing).");

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
      ).then(
        (r) => ok(r),
        (e: unknown) => upstreamFailure("web_search", e),
      );
      if (res.isErr()) return reject(`web_search failed: ${res.error}`);

      const data = TavilySearchResponseSchema.parse(await res.value.json());

      if (data.results.length === 0) return ok("No results found.");

      return ok(data.results.map((r) => `[${r.title}](${r.url})\n${r.content}`).join("\n\n"));
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
    durable: true,
    parallelSafe: true,
    sideEffectful: false,
    schema: z.object({
      question: z.string().describe("The question to answer"),
    }),
    handler: async (input) => {
      if (!apiKey) return reject("web_answer is not configured (OPENROUTER_API_KEY missing).");

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
      ).then(
        (r) => ok(r),
        (e: unknown) => upstreamFailure("web_answer", e),
      );
      if (res.isErr()) return reject(`web_answer failed: ${res.error}`);

      const data = OpenRouterAnswerSchema.parse(await res.value.json());

      const answer = data.choices[0]?.message.content ?? "No answer returned.";
      const citations = data.citations;

      if (citations && citations.length > 0) {
        return ok(`${answer}\n\nSources:\n${citations.map((c) => `- ${c}`).join("\n")}`);
      }
      return ok(answer);
    },
  });
}

// --- fetch_url ---

function createFetchUrl(tavilyApiKey: string | undefined, resolveHost: ResolveHost): ToolSpec {
  return defineTool({
    name: "fetch_url",
    description:
      "Fetch and extract the main content from a URL. " +
      "Returns cleaned article text for web pages, or raw text for non-HTML content. " +
      "Use this when you need to read a specific web page.",
    // Durable: a paid Tavily Extract call, re-billed once per subsequent
    // step boundary when non-durable. Output is capped at MAX_CONTENT_LENGTH,
    // so the cached value stays within Inngest state limits.
    durable: true,
    parallelSafe: true,
    sideEffectful: false,
    schema: z.object({
      url: z.string().url().describe("The URL to fetch (http or https only)"),
    }),
    handler: async (input) => {
      const direct = await directFetch(new URL(input.url), resolveHost);
      const fetched: Result<string, ToolRejection> = direct.isOk()
        ? ok(direct.value)
        : await afterDirectFailure(direct.error, input.url, tavilyApiKey);
      if (fetched.isErr()) return err(fetched.error);
      let content = fetched.value;

      if (content.length > MAX_CONTENT_LENGTH) {
        content = `${content.slice(0, MAX_CONTENT_LENGTH)}\n\n[Content truncated at ${MAX_CONTENT_LENGTH} characters]`;
      }

      return ok(content || "No content could be extracted from this URL.");
    },
  });
}

/**
 * Why a direct fetch ended without a page. `refused` is a destination off the
 * public internet and `unresolvable` a host the resolver had no answer for.
 * `permanent` is a page that isn't there to fetch over HTTP. `transient` is
 * one Tavily might still reach: a bot block or flaky server that outlasted
 * the retries, a redirect loop, a body or page that failed to read.
 */
type DirectFetchFailure =
  | { kind: "refused"; message: string }
  | { kind: "unresolvable"; host: string }
  | { kind: "permanent"; message: string }
  | { kind: "transient"; message: string };

interface Reached {
  response: Response;
  finalUrl: URL;
}

/**
 * The model's answer when the direct fetch failed. Only a `transient` failure
 * goes to Tavily Extract: it can't conjure a page that isn't there, and a
 * refused or unresolvable host, query string and all, is not one to hand it.
 */
function afterDirectFailure(
  failure: DirectFetchFailure,
  url: string,
  tavilyApiKey: string | undefined,
): Promise<Result<string, ToolRejection>> {
  return match(failure)
    .with({ kind: "refused" }, { kind: "permanent" }, async ({ message }) => reject(message))
    .with({ kind: "unresolvable" }, async ({ host }) => reject(`Could not resolve ${host}.`))
    .with({ kind: "transient" }, async ({ message }) => {
      if (!tavilyApiKey) return reject(message);
      logger.info(
        { url: new URL(url).hostname, originalError: message },
        "fetch_url falling back to Tavily Extract",
      );
      return tavilyExtract(url, tavilyApiKey, message);
    })
    .exhaustive();
}

/**
 * Fetch `url` directly. A throw inside the retried attempt is only
 * `withRetry`'s signal to try again; what is left when the retries run out
 * is `unresolvable` after {@link LookupUnavailable}, else `transient`.
 */
async function directFetch(
  url: URL,
  resolveHost: ResolveHost,
): Promise<Result<string, DirectFetchFailure>> {
  let attempt = 0;
  const reached = await withRetry(
    async (): Promise<Result<Reached, DirectFetchFailure>> => {
      attempt += 1;
      // First attempt looks like a typed-URL navigation. Subsequent
      // attempts add a same-origin Referer + flip Sec-Fetch-Site to
      // cross-site — some bot filters reject only no-referer hits.
      const headers = attempt === 1 ? BROWSER_HEADERS : retryHeaders(url.href);
      const hops = await fetchCheckingEachHop(url, headers, resolveHost);
      if (hops.isErr()) return hops;
      const r = hops.value.response;
      // 403/429 are retryable here: many bot filters return them on
      // a no-referer first hit and let the retry-with-Referer
      // through. 5xx is the usual transient-server case. Other 4xx
      // (404, 401, etc.) are permanent.
      if (r.status >= 500 || r.status === 403 || r.status === 429) {
        throw new Error(`Fetch failed: ${r.status} ${r.statusText}`);
      }
      if (!r.ok) {
        return err({ kind: "permanent", message: `Fetch failed: ${r.status} ${r.statusText}` });
      }
      return hops;
    },
    // retries: 2 — fetch_url is user-facing through the agent, cap
    // total wall-clock at 20s so a slow upstream can't make the
    // user wait through three full 15s timeouts. Context uses only
    // the hostname so query-string secrets (api keys, signed URLs)
    // don't end up in the logs.
    { retries: 2, maxRetryTimeMs: 20_000, context: `fetch_url ${url.hostname}` },
  ).catch(
    (e: unknown): Result<Reached, DirectFetchFailure> =>
      err(
        e instanceof LookupUnavailable
          ? { kind: "unresolvable", host: e.host }
          : transientFailure(e),
      ),
  );
  if (reached.isErr()) return err(reached.error);

  const { response, finalUrl } = reached.value;
  const body = await response.text().then(
    (text) => ok(text),
    (e: unknown) => err(transientFailure(e)),
  );
  if (body.isErr()) return err(body.error);
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("text/html")
    ? Result.fromThrowable(extractArticle, transientFailure)(body.value, finalUrl.href)
    : ok(body.value);
}

function transientFailure(e: unknown): DirectFetchFailure {
  return { kind: "transient", message: e instanceof Error ? e.message : String(e) };
}

/**
 * Thrown inside a retried attempt when the resolver is briefly unavailable,
 * so the attempt runs again; {@link directFetch} turns it into `unresolvable`
 * once the retries run out.
 */
class LookupUnavailable extends Error {
  constructor(
    readonly host: string,
    cause: unknown,
  ) {
    super(`resolver unavailable for ${host}`, { cause });
    this.name = "LookupUnavailable";
  }
}

/**
 * GET `url`, following redirects here rather than in `fetch` so every hop
 * passes {@link checkDestination} before it is connected to: a public page
 * redirecting inward is the standard way around a guard like this. One
 * timeout spans resolution and every hop.
 *
 * A chain this can't follow is `transient`, returned rather than thrown so
 * it isn't retried: every hop passed the check, and Tavily gets past a
 * cookie wall (`302 Location: /article` plus a cookie, repeating) that
 * `fetch`, with no cookie jar, loops on.
 */
async function fetchCheckingEachHop(
  url: URL,
  headers: Record<string, string>,
  resolveHost: ResolveHost,
): Promise<Result<Reached, DirectFetchFailure>> {
  const signal = AbortSignal.timeout(ATTEMPT_BUDGET_MS);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const allowed = await checkDestination(current, resolveHost, signal);
    if (allowed.isErr()) return err(allowed.error);
    const response = await fetch(current.href, { headers, redirect: "manual", signal });
    const location = REDIRECT_STATUSES.has(response.status)
      ? response.headers.get("location")
      : null;
    if (location === null) return ok({ response, finalUrl: current });
    await response.body?.cancel();
    const next = URL.parse(location, current);
    if (next === null) {
      return err({
        kind: "transient",
        message: `Fetch failed: ${current.hostname} redirected to an unparseable location.`,
      });
    }
    current = next;
  }
  return err({ kind: "transient", message: `Fetch failed: more than ${MAX_REDIRECTS} redirects.` });
}

/**
 * Refuse a destination off the public internet. Why, and the DNS-rebinding
 * residual: design/agents.md → Security: `fetch_url` Destinations. The
 * address stays out of the refusal, which the model reads, and goes to the
 * log for the operator.
 */
async function checkDestination(
  url: URL,
  resolveHost: ResolveHost,
  signal: AbortSignal,
): Promise<Result<void, DirectFetchFailure>> {
  // `permanent`, not `transient`: neither `fetch` nor Tavily, which would
  // follow the same redirect, reaches a page outside HTTP.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return err({ kind: "permanent", message: `Unsupported protocol: ${url.protocol}` });
  }
  const addresses = await addressesOf(url, resolveHost, signal);
  if (addresses.isErr()) return err(addresses.error);
  const blocked = addresses.value.find((a) => isBlockedAddress(a.address, a.family));
  if (blocked === undefined) return ok(undefined);
  logger.info(
    { host: url.hostname, address: blocked.address },
    "fetch_url refused a non-public destination",
  );
  return err({
    kind: "refused",
    message: `Fetching private/internal URLs is not allowed (${url.hostname}).`,
  });
}

/**
 * An IP literal as written; a name by every address it resolves to. A
 * resolver that is briefly unavailable (`EAI_AGAIN`, or no answer within
 * `LOOKUP_TIMEOUT_MS`) throws {@link LookupUnavailable} so the attempt is
 * retried; any other resolver failure is final. The attempt's own budget
 * running out mid-lookup rethrows as the timeout it is.
 */
async function addressesOf(
  url: URL,
  resolveHost: ResolveHost,
  signal: AbortSignal,
): Promise<Result<ReadonlyArray<LookupAddress>, DirectFetchFailure>> {
  // `URL.hostname` keeps an IPv6 literal's brackets.
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const family = isIP(host);
  if (family !== 0) return ok([{ address: host, family }]);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]);
  try {
    return ok(await abortable(resolveHost(host), deadline));
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    logger.info({ host, err: describeError(e) }, "fetch_url could not resolve a host");
    if (isLookupTimeout(e) || errorCode(e) === "EAI_AGAIN") throw new LookupUnavailable(host, e);
    return err({ kind: "unresolvable", host });
  }
}

function isLookupTimeout(e: unknown): boolean {
  return e instanceof Error && e.name === "TimeoutError";
}

function errorCode(e: unknown): unknown {
  return e instanceof Error && "code" in e ? e.code : undefined;
}

const TavilySearchResponseSchema = z.object({
  results: z.array(z.object({ title: z.string(), url: z.string(), content: z.string() })),
});

const OpenRouterAnswerSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })),
  citations: z.array(z.string()).optional(),
});

const TavilyExtractResponseSchema = z.object({
  results: z.array(z.object({ url: z.string(), raw_content: z.string().nullish() })),
  failed_results: z.array(z.object({ url: z.string(), error: z.string() })).optional(),
});

async function tavilyExtract(
  url: string,
  apiKey: string,
  directError: string,
): Promise<Result<string, ToolRejection>> {
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
  ).then(
    (r) => ok(r),
    (e: unknown) => upstreamFailure("fetch_url", e),
  );
  if (res.isErr()) {
    return reject(
      `Failed to fetch URL. Direct fetch: ${directError}. Tavily fallback: ${res.error}`,
    );
  }

  const data = TavilyExtractResponseSchema.parse(await res.value.json());
  const result = data.results[0];
  if (result?.raw_content) return ok(result.raw_content);

  const tavilyError = data.failed_results?.[0]?.error ?? "Tavily returned no content";
  // Surface both errors so the agent (and logs) know the direct path
  // failed AND the fallback failed — useful for diagnosing whether to
  // tweak headers further or accept that this site needs a real
  // browser.
  return reject(
    `Failed to fetch URL. Direct fetch: ${directError}. Tavily fallback: ${tavilyError}`,
  );
}

/**
 * The error a `withRetry`-wrapped upstream request ended on — a status it gave
 * up on or aborted at, a network failure — as its message. An upstream outage
 * or refusal is an expected external failure the model can relay, so it logs
 * at warn rather than surfacing as a bug.
 */
function upstreamFailure(tool: string, e: unknown): Err<never, string> {
  logger.warn({ err: e, tool }, "web tool upstream request failed");
  return err(e instanceof Error ? e.message : String(e));
}

function extractArticle(html: string, url: string): string {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  return article?.textContent?.trim() ?? "";
}
