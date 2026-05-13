/**
 * `fetch` wrapper that logs the full outbound request body and the upstream
 * response body whenever an LLM call fails.
 *
 * Interception strategy: both the OpenAI and Anthropic SDKs are Stainless-
 * generated and accept a `{ fetch }` constructor option. A swapped fetch is
 * the only point that owns both the outbound `Request` and the inbound
 * `Response` — neither SDK exposes the request body on its `APIError`, and
 * neither has an `onRequest` / `onError` hook. The SDKs also offer a
 * `logger` + `logLevel: "debug"` knob, but that logs every success too and
 * only partially redacts headers.
 *
 * Failure-only: a cheap `req.clone()` runs up front (stream tee — shares
 * the underlying chunks, no copy). The inner fetch consumes the original;
 * the clone's body stays unread until the failure branch decides to log,
 * so the success path pays only the tee cost. One trade-off: the clone
 * holds a reference to the underlying body until the SDK consumer fully
 * drains the response, so for streaming SSE responses with a multi-MB
 * request body, that body lives slightly longer than it otherwise would.
 * Negligible at single-user scale.
 *
 * Scope: targets JSON request/response bodies, which is what both SDKs
 * emit for chat/messages endpoints. Binary bodies (image gen, voice) and
 * SSE error events that arrive mid-200-stream are out of scope — the
 * former would log as UTF-8 replacement chars, the latter never reaches
 * `!res.ok`.
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
  "openrouter-api-key",
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
 * Never throws — on any stream failure (including `getReader()` rejecting
 * because the body is already locked) returns `"<read failed>"` so the
 * rest of the log record still goes through.
 */
async function safeReadTextWithLimit(
  source: { body: ReadableStream<Uint8Array> | null },
  limit: number,
): Promise<string> {
  if (!source.body) return "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    // `getReader()` throws synchronously if the stream is already locked —
    // keep it inside the try so the failure path still logs the rest of
    // the record instead of bubbling out to the wrapper's outer catch.
    reader = source.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    let truncated = false;
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
    const combined = new Uint8Array(bytesRead);
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(combined);
    return truncated ? `${text}\n… [truncated at ${limit} bytes]` : text;
  } catch {
    return "<read failed>";
  } finally {
    // Fire-and-forget: cancelling can hang on certain stream sources, and
    // we've already extracted everything we need.
    if (reader !== null) reader.cancel().catch(() => {});
  }
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
