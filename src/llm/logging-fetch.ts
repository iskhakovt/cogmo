/**
 * `fetch` wrapper that logs the full outbound request body and the upstream
 * response body whenever an LLM call fails.
 *
 * Why this exists: the OpenAI and Anthropic SDKs surface `err.status` and
 * `err.message` on their `APIError` subclasses, but neither carries the
 * request body. When grok-4.3 started 502'ing on tool schemas with `/` in
 * an `enum` (see PR #240), production logs gave us "Invalid arguments
 * passed to the model" and nothing else — we had to reproduce locally with
 * progressively-narrowing payloads to find the offending field. A
 * request-body dump at the failure boundary would have made the diagnosis
 * a one-line ops task.
 *
 * Interception strategy: both SDKs are Stainless-generated and accept a
 * `{ fetch }` constructor option. The fetch wrapper is the only point that
 * owns both the outbound `Request` and the inbound `Response`. The SDKs
 * also expose `logger` + `logLevel: "debug"`, but that logs every success
 * too (too noisy) and only partially redacts headers (not enough); the
 * `fetch` swap is the standard recommendation in the ecosystem.
 *
 * Failure-only: we buffer the request body once at entry (Request streams
 * are one-shot, so we clone before reading), call the inner fetch, and
 * emit a log only when `!res.ok` or the call throws. Successful requests
 * stay silent.
 */

import type { Logger } from "pino";

/**
 * Header names whose values must be redacted before logging. Lowercase —
 * `Headers#get` normalises case but iteration may not.
 */
const REDACTED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "anthropic-api-key",
  "proxy-authorization",
  "cookie",
]);

/**
 * Cap the body we read into the log to keep individual records bounded.
 * Tool catalogs + system prompts can be a few KB; conversation history can
 * be several MB. 100KB is enough to diagnose tool-schema issues and the
 * first few turns of a conversation without blowing out the log pipeline.
 */
const BODY_LOG_LIMIT_BYTES = 100 * 1024;

/**
 * Wrap a `fetch` so that failed LLM requests log their full payload.
 *
 * Pass the result into the LLM SDK constructors:
 * `new OpenAI({ fetch: withFailureLogging(fetch, log, "openrouter") })`.
 */
export function withFailureLogging(
  baseFetch: typeof fetch,
  log: Logger,
  providerName: string,
): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const reqBody = await safeReadTextWithLimit(req.clone(), BODY_LOG_LIMIT_BYTES);
    try {
      const res = await baseFetch(req);
      if (!res.ok) {
        const resBody = await safeReadTextWithLimit(res.clone(), BODY_LOG_LIMIT_BYTES);
        log.error(
          {
            providerName,
            url: req.url,
            method: req.method,
            status: res.status,
            headers: redactHeaders(req.headers),
            requestBody: reqBody,
            responseBody: resBody,
          },
          "llm request failed",
        );
      }
      return res;
    } catch (err) {
      log.error(
        {
          providerName,
          url: req.url,
          method: req.method,
          headers: redactHeaders(req.headers),
          requestBody: reqBody,
          err,
        },
        "llm request threw",
      );
      throw err;
    }
  };
}

/**
 * Read the body as text up to `limit` bytes; never throws. On read failure
 * returns a placeholder so the rest of the log record still goes through.
 */
async function safeReadTextWithLimit(
  source: { text(): Promise<string> },
  limit: number,
): Promise<string> {
  let body: string;
  try {
    body = await source.text();
  } catch {
    return "<read failed>";
  }
  if (body.length <= limit) return body;
  return `${body.slice(0, limit)}\n… [truncated, full body ${body.length} bytes]`;
}

/**
 * Produce a redacted snapshot of the headers suitable for logging. The
 * source `Headers` is not mutated. Bearer-style auth headers are replaced
 * wholesale (length doesn't carry diagnostic value).
 */
function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    out[name] = REDACTED_HEADERS.has(name.toLowerCase()) ? "[REDACTED]" : value;
  }
  return out;
}
