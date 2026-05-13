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
    // Tee the body now (cheap — streams share underlying chunks) but defer
    // the actual read until the failure path. Successful requests skip the
    // copy entirely, which is the dominant case at runtime.
    const reqClone = req.clone();
    try {
      const res = await baseFetch(req);
      if (!res.ok) {
        const [reqBody, resBody] = await Promise.all([
          safeReadTextWithLimit(reqClone, BODY_LOG_LIMIT_BYTES),
          safeReadTextWithLimit(res.clone(), BODY_LOG_LIMIT_BYTES),
        ]);
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
      const reqBody = await safeReadTextWithLimit(reqClone, BODY_LOG_LIMIT_BYTES);
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
 * Read up to `limit` bytes of `source.body`'s stream, decode as UTF-8, and
 * append a `[truncated …]` marker if the source had more. Cancels the
 * reader once the limit is hit so we never buffer a multi-megabyte body
 * just to throw most of it away.
 *
 * Never throws — on any stream failure returns a placeholder so the rest
 * of the log record still goes through.
 */
async function safeReadTextWithLimit(
  source: { body: ReadableStream<Uint8Array> | null },
  limit: number,
): Promise<string> {
  if (!source.body) return "";
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;
  try {
    while (bytesRead < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, limit - bytesRead);
      chunks.push(take === value.byteLength ? value : value.subarray(0, take));
      bytesRead += take;
      if (take < value.byteLength) {
        // More data in this chunk than we want — mark truncated and stop.
        truncated = true;
        break;
      }
    }
    // Reached the byte budget on a chunk boundary — probe whether the
    // source had more, so the marker is accurate.
    if (!truncated && bytesRead >= limit) {
      const { done } = await reader.read();
      if (!done) truncated = true;
    }
  } catch {
    return "<read failed>";
  } finally {
    // Fire-and-forget: cancelling can hang on certain stream sources, and
    // we've already extracted everything we need.
    reader.cancel().catch(() => {});
  }
  const combined = new Uint8Array(bytesRead);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(combined);
  return truncated ? `${text}\n… [truncated at ${limit} bytes]` : text;
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
