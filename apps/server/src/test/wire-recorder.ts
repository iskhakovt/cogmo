/**
 * `fetch` wrapper that records LLM requests exactly as they are sent, and the
 * usage their responses report — the harness for asserting what an adapter
 * puts on the wire (design/prompt-caching.md → Test Plan → Harness).
 *
 * Hand `recorder.fetch` to an adapter's injectable fetch
 * (`new AnthropicProvider(key, baseURL, { fetch })`,
 * `OpenAICompatibleConfig.fetch`). The adapter wraps it in its failure logger,
 * so the recorder sits between the SDK and the network and sees the final
 * request.
 *
 * The response body is teed: the caller reads one branch unchanged while the
 * recorder reads the other to the end and pulls out the message id, the usage
 * block and cache diagnostics — from an Anthropic stream's `message_start`, an
 * OpenAI stream's final chunk, or a JSON body. llmock's request journal can't
 * stand in for this: it stores its own OpenAI-shaped conversion of an
 * Anthropic request, without `cache_control`, system blocks or the top-level
 * field.
 */

import * as R from "remeda";
import { z } from "zod";
import { redactHeaders } from "../llm/logging-fetch.js";

type JsonObject = Record<string, unknown>;

export interface WireRequest {
  url: string;
  method: string;
  /** As sent, with credentials redacted. Header names are lower-case. */
  headers: Record<string, string>;
  /** The JSON body as sent, parsed; `undefined` for a request without one. */
  body: JsonObject | undefined;
}

export interface WireResponse {
  status: number;
  /** The response's message id: Anthropic `message.id`, OpenAI `id`. */
  id: string | undefined;
  /**
   * The provider's usage block as reported — Anthropic's
   * `message_start.message.usage` or body `usage`, `cache_creation` TTL
   * breakdown included; OpenAI's final-chunk or body `usage`. Parse it where
   * it is read.
   */
  usage: unknown;
  /** Anthropic cache diagnostics, when the request opted in. */
  diagnostics: unknown;
}

export interface WireExchange {
  request: WireRequest;
  /**
   * Settles once the recorder has read the response body to the end. Rejects
   * with the request's own error when the request failed to complete.
   */
  response: Promise<WireResponse>;
}

/** The parts of a request a mutator may rewrite. */
export interface WireRequestInit {
  headers: Headers;
  body: JsonObject | undefined;
}

export interface WireRecorderOptions {
  /**
   * Rewrites each request before it is recorded and sent — how the live tier
   * adds headers and body fields that production code never sends. Receives
   * copies; returns what to send.
   */
  mutate?(url: string, init: WireRequestInit): WireRequestInit;
}

export interface WireRecorder {
  fetch: typeof fetch;
  /** Every exchange so far, in the order its request was sent. */
  readonly exchanges: ReadonlyArray<WireExchange>;
}

type Capture = Omit<WireResponse, "status">;

const NOTHING_CAPTURED: Capture = { id: undefined, usage: undefined, diagnostics: undefined };

const JsonObjectSchema = z.record(z.string(), z.unknown());

/** A non-streaming Anthropic message or OpenAI completion; an error body matches with every field absent. */
const ResponseBodySchema = z.object({
  id: z.string().optional(),
  usage: z.unknown().optional(),
  diagnostics: z.unknown().optional(),
});

const MessageStartSchema = z.object({
  type: z.literal("message_start"),
  message: z.object({
    id: z.string(),
    usage: z.unknown(),
    diagnostics: z.unknown().optional(),
  }),
});

/** An OpenAI chunk: it has no `type`, which every Anthropic stream event carries. */
const ChatChunkSchema = z.object({
  type: z.never().optional(),
  id: z.string().optional(),
  usage: z.unknown().optional(),
});

/**
 * Record every request made through the returned `fetch`, forwarding each to
 * `inner` (the global fetch when omitted).
 */
export function createWireRecorder(inner?: typeof fetch, opts?: WireRecorderOptions): WireRecorder {
  const exchanges: WireExchange[] = [];

  async function recordingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const original = new Request(input, init);
    const originalText = original.body === null ? undefined : await original.text();
    const originalBody =
      originalText === undefined ? undefined : parseRequestBody(originalText, original.url);
    const mutated = opts?.mutate?.(original.url, {
      headers: new Headers(original.headers),
      body: structuredClone(originalBody),
    });
    // Without a mutator the original bytes go out untouched.
    const sentText = mutated
      ? mutated.body === undefined
        ? undefined
        : JSON.stringify(mutated.body)
      : originalText;
    const headers = mutated?.headers ?? original.headers;
    const request = new Request(original.url, {
      method: original.method,
      headers,
      signal: original.signal,
      ...(sentText !== undefined && { body: sentText }),
    });

    const { promise: response, resolve, reject } = Promise.withResolvers<WireResponse>();
    // A test that never awaits this exchange must not see a failed request
    // as an unhandled rejection; the caller of `fetch` gets the error itself.
    response.catch(() => {});
    exchanges.push({
      request: {
        url: original.url,
        method: original.method,
        headers: redactHeaders(headers),
        body: sentText === undefined ? undefined : parseRequestBody(sentText, original.url),
      },
      response,
    });

    let res: Response;
    try {
      res = await (inner ?? globalThis.fetch)(request);
    } catch (err) {
      reject(err);
      throw err;
    }
    if (res.body === null) {
      resolve({ status: res.status, ...NOTHING_CAPTURED });
      return res;
    }
    const [toCaller, toRecorder] = res.body.tee();
    const contentType = res.headers.get("content-type");
    new Response(toRecorder)
      .text()
      .then(
        (text) => resolve({ status: res.status, ...captureResponse(text, contentType) }),
        reject,
      );
    return new Response(toCaller, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  return {
    fetch: recordingFetch,
    get exchanges() {
      return [...exchanges];
    },
  };
}

function parseRequestBody(text: string, url: string): JsonObject {
  const parsed = JsonObjectSchema.safeParse(parseJsonOrUndefined(text));
  if (!parsed.success) {
    throw new Error(`wire recorder: the request body sent to ${url} is not a JSON object`);
  }
  return parsed.data;
}

function captureResponse(text: string, contentType: string | null): Capture {
  if (contentType?.includes("text/event-stream")) return captureStream(text);
  const body = ResponseBodySchema.safeParse(parseJsonOrUndefined(text));
  if (!body.success) return NOTHING_CAPTURED;
  return { id: body.data.id, usage: body.data.usage, diagnostics: body.data.diagnostics };
}

/**
 * Anthropic reports the request's id, usage and diagnostics once, on
 * `message_start`. OpenAI repeats the id on every chunk and reports usage on
 * the last one (`stream_options.include_usage`), with `usage: null` before it.
 */
function captureStream(text: string): Capture {
  const events = text.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith("data:")) return [];
    const data = line.slice("data:".length).trim();
    return data === "" || data === "[DONE]" ? [] : [parseJsonOrUndefined(data)];
  });
  return R.reduce(
    events,
    (capture: Capture, event): Capture => {
      const start = MessageStartSchema.safeParse(event);
      if (start.success) {
        const { id, usage, diagnostics } = start.data.message;
        return { id, usage, diagnostics };
      }
      const chunk = ChatChunkSchema.safeParse(event);
      if (!chunk.success) return capture;
      return {
        ...capture,
        id: capture.id ?? chunk.data.id,
        usage: chunk.data.usage ?? capture.usage,
      };
    },
    NOTHING_CAPTURED,
  );
}

/** A body that isn't JSON (a proxy's HTML error page) has nothing to capture. */
function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
