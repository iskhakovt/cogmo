import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import { expectDefined } from "../test/assertions.js";
import { withFailureLogging } from "./logging-fetch.js";

/**
 * Shape of the structured payload `withFailureLogging` passes to
 * `log.error`. Zod-parsed in tests so reads are typed without `as` casts
 * (pino's `LogFn` overload erases the payload type at the mock-call site).
 */
const FailureLogPayload = z
  .object({
    providerName: z.string(),
    url: z.string(),
    method: z.string(),
    status: z.number().optional(),
    headers: z.record(z.string(), z.string()),
    requestBody: z.string(),
    responseBody: z.string().optional(),
    err: z.unknown().optional(),
  })
  .passthrough();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Pull the parsed payload + message off the n-th `log.error` call.
 * Throws (via `expectDefined`) if the call is missing.
 */
function failureCall(
  log: Logger,
  index = 0,
): { payload: z.infer<typeof FailureLogPayload>; msg: string } {
  const call = expectDefined(vi.mocked(log.error).mock.calls[index], `log.error call ${index}`);
  const [obj, msg] = call;
  return { payload: FailureLogPayload.parse(obj), msg: typeof msg === "string" ? msg : "" };
}

describe("withFailureLogging", () => {
  it("does not log when the response is OK", async () => {
    const inner = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }));
    const log = mock<Logger>();
    const wrapped = withFailureLogging(inner, log, "openrouter");

    const res = await wrapped("https://example/v1/chat", {
      method: "POST",
      body: JSON.stringify({ model: "gpt", messages: [] }),
      headers: { authorization: "Bearer sk-real-key" },
    });

    expect(res.status).toBe(200);
    expect(log.error).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("does not consume the request body on the success path", async () => {
    // Lazy-read invariant for the success path: the cloned body must stay
    // unread, so the only buffering cost on a happy request is the cheap
    // stream tee from req.clone(). Spy on the wrapper's clone to confirm
    // its stream reader is never acquired when the call succeeds.
    let cloneReaderAcquired = 0;
    const originalClone = Request.prototype.clone;
    const cloneSpy = vi.fn(function (this: Request): Request {
      const cloned = originalClone.call(this);
      const body = cloned.body;
      if (body) {
        const realGetReader = body.getReader.bind(
          body,
        ) as () => ReadableStreamDefaultReader<Uint8Array>;
        body.getReader = (() => {
          cloneReaderAcquired++;
          return realGetReader();
        }) as typeof body.getReader;
      }
      return cloned;
    });
    Request.prototype.clone = cloneSpy as typeof Request.prototype.clone;

    try {
      const inner = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }));
      const log = mock<Logger>();
      const wrapped = withFailureLogging(inner, log, "test");

      await wrapped("https://example/v1/chat", {
        method: "POST",
        body: '{"hello":"world"}',
      });

      expect(cloneReaderAcquired).toBe(0);
    } finally {
      Request.prototype.clone = originalClone;
    }
  });

  it("logs the full request + response body on a 4xx/5xx", async () => {
    const inner = vi.fn<typeof fetch>(async () =>
      jsonResponse(502, { error: { message: "Invalid grammar request" } }),
    );
    const log = mock<Logger>();
    const wrapped = withFailureLogging(inner, log, "openrouter");

    const requestBody = JSON.stringify({
      model: "x-ai/grok-4.3",
      tools: [{ function: { parameters: { properties: { model: { enum: ["a/b"] } } } } }],
    });
    const res = await wrapped("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: requestBody,
      headers: { authorization: "Bearer sk-real-key", "content-type": "application/json" },
    });

    expect(res.status).toBe(502);
    const { payload } = failureCall(log);
    expect(payload.providerName).toBe("openrouter");
    expect(payload.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(payload.method).toBe("POST");
    expect(payload.status).toBe(502);
    expect(payload.requestBody).toBe(requestBody);
    expect(payload.responseBody).toContain("Invalid grammar request");
  });

  it("redacts authorization-style headers", async () => {
    const inner = vi.fn<typeof fetch>(async () => jsonResponse(400, { error: "bad request" }));
    const log = mock<Logger>();
    const wrapped = withFailureLogging(inner, log, "anthropic");

    await wrapped("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: "{}",
      headers: {
        authorization: "Bearer sk-real-key",
        "x-api-key": "sk-also-secret",
        "anthropic-api-key": "sk-also-secret",
        "openrouter-api-key": "sk-or-secret",
        "content-type": "application/json",
      },
    });

    const { payload } = failureCall(log);
    expect(payload.headers.authorization).toBe("[REDACTED]");
    expect(payload.headers["x-api-key"]).toBe("[REDACTED]");
    expect(payload.headers["anthropic-api-key"]).toBe("[REDACTED]");
    expect(payload.headers["openrouter-api-key"]).toBe("[REDACTED]");
    expect(payload.headers["content-type"]).toBe("application/json");
    // No partial leak of any secret.
    const serialized = JSON.stringify(payload.headers);
    expect(serialized).not.toContain("sk-real-key");
    expect(serialized).not.toContain("sk-also-secret");
    expect(serialized).not.toContain("sk-or-secret");
  });

  it("truncates the request body at the 100KB limit with a marker", async () => {
    const inner = vi.fn<typeof fetch>(async () => jsonResponse(400, { error: "too big" }));
    const log = mock<Logger>();
    const wrapped = withFailureLogging(inner, log, "test");

    const huge = "x".repeat(200 * 1024); // 200KB
    await wrapped("https://example/v1/chat", { method: "POST", body: huge });

    const { payload } = failureCall(log);
    expect(payload.requestBody.length).toBeLessThan(huge.length);
    expect(payload.requestBody).toMatch(/\[truncated at \d+ bytes\]$/);
    expect(payload.requestBody.startsWith("x".repeat(100))).toBe(true);
  });

  it("logs and rethrows when the inner fetch throws", async () => {
    const networkErr = new Error("ECONNREFUSED");
    const inner = vi.fn<typeof fetch>(async () => {
      throw networkErr;
    });
    const log = mock<Logger>();
    const wrapped = withFailureLogging(inner, log, "openai");

    await expect(wrapped("https://example/v1/chat", { method: "POST", body: "{}" })).rejects.toBe(
      networkErr,
    );

    const { payload, msg } = failureCall(log);
    expect(msg).toMatch(/threw/);
    expect(payload.err).toBe(networkErr);
    expect(payload.requestBody).toBe("{}");
  });

  it("returns the original (unread) response body to the caller on failure", async () => {
    // Cloning behaviour: the body we logged must not consume the body the
    // SDK consumer needs. Confirms the consumer can still .json() the
    // response after our wrapper logged its content.
    const inner = vi.fn<typeof fetch>(async () =>
      jsonResponse(429, { error: { code: "rate_limit" } }),
    );
    const log = mock<Logger>();
    const wrapped = withFailureLogging(inner, log, "test");

    const res = await wrapped("https://example/v1/chat", { method: "POST", body: "{}" });
    const parsed = (await res.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe("rate_limit");
  });

  it("handles GET requests with no body — logs an empty requestBody", async () => {
    // Anthropic SDK uses GET for endpoints like `client.models.list()`.
    // With no body, `Request.body` is null and the reader path is skipped.
    const inner = vi.fn<typeof fetch>(async () =>
      jsonResponse(404, { error: { type: "not_found" } }),
    );
    const log = mock<Logger>();
    const wrapped = withFailureLogging(inner, log, "anthropic");

    const res = await wrapped("https://api.anthropic.com/v1/models/missing", {
      method: "GET",
    });

    expect(res.status).toBe(404);
    const { payload } = failureCall(log);
    expect(payload.method).toBe("GET");
    expect(payload.requestBody).toBe("");
    expect(payload.responseBody).toContain("not_found");
  });

  it("truncates correctly when the body arrives as multiple chunks", async () => {
    // Production bodies are chunked by undici / the Node fetch
    // implementation; the streaming reader has to walk multiple chunks and
    // stop at the byte budget. Build a body via a hand-rolled ReadableStream
    // of small chunks that collectively cross the limit, and verify only
    // the prefix lands.
    const CHUNK_SIZE = 4 * 1024; // 4KB chunks
    const TOTAL_CHUNKS = 40; // 160KB total, crosses the 100KB cap
    const chunk = new TextEncoder().encode("y".repeat(CHUNK_SIZE));
    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < TOTAL_CHUNKS; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const inner = vi.fn<typeof fetch>(async () => jsonResponse(400, { error: "too big" }));
    const log = mock<Logger>();
    const wrapped = withFailureLogging(inner, log, "test");

    await wrapped("https://example/v1/chat", {
      method: "POST",
      body: bodyStream,
      // Required for streaming bodies under Node's fetch (otherwise
      // `new Request` rejects).
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const { payload } = failureCall(log);
    expect(payload.requestBody.length).toBeLessThan(CHUNK_SIZE * TOTAL_CHUNKS);
    expect(payload.requestBody).toMatch(/\[truncated at \d+ bytes\]$/);
    // The visible prefix is all 'y' (no chunk boundary leaked anything else).
    expect(payload.requestBody.startsWith("y".repeat(100))).toBe(true);
  });

  it("returns '<read failed>' instead of throwing when the body is already locked", async () => {
    // Defensive: if another interceptor (or a future maintainer) locks the
    // body before we read, getReader() throws synchronously. The wrapper's
    // failure-log path must not bubble that exception out — it would mask
    // the real upstream error and drop the response. Lock the clone's body
    // pre-emptively to drive this branch.
    const inner = vi.fn<typeof fetch>(async (input) => {
      const req = input instanceof Request ? input : new Request(input);
      // Drain the original request to ensure baseFetch is well-behaved,
      // then return a failing response.
      await req.text();
      return jsonResponse(500, { error: "boom" });
    });
    const log = mock<Logger>();
    const wrapped = withFailureLogging(inner, log, "test");

    // Pre-acquire (and never release) a reader on every Request clone so
    // the wrapper's safeReadTextWithLimit hits the locked-stream path.
    const originalClone = Request.prototype.clone;
    const lockingClone = vi.fn(function (this: Request): Request {
      const cloned = originalClone.call(this);
      cloned.body?.getReader(); // lock and discard — never released
      return cloned;
    });
    Request.prototype.clone = lockingClone as typeof Request.prototype.clone;

    try {
      const res = await wrapped("https://example/v1/chat", { method: "POST", body: "{}" });
      expect(res.status).toBe(500);
      const { payload } = failureCall(log);
      expect(payload.requestBody).toBe("<read failed>");
      // The upstream error body is still readable because its clone was
      // also taken via the same patched clone — locked too — so it reads
      // as "<read failed>". The important assertion is that we logged
      // (not threw) and surfaced the upstream 500.
      expect(payload.status).toBe(500);
    } finally {
      Request.prototype.clone = originalClone;
    }
  });
});
