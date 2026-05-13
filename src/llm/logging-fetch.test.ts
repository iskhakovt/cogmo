import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { withFailureLogging } from "./logging-fetch.js";

function fakeLogger(): { log: Logger; errorCalls: Array<{ obj: unknown; msg: string }> } {
  const errorCalls: Array<{ obj: unknown; msg: string }> = [];
  const log = {
    error: (obj: unknown, msg: string) => {
      errorCalls.push({ obj, msg });
    },
  } as unknown as Logger;
  return { log, errorCalls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("withFailureLogging", () => {
  it("does not log when the response is OK", async () => {
    const inner = vi.fn(async () => jsonResponse(200, { ok: true }));
    const { log, errorCalls } = fakeLogger();
    const wrapped = withFailureLogging(inner as unknown as typeof fetch, log, "openrouter");

    const res = await wrapped("https://example/v1/chat", {
      method: "POST",
      body: JSON.stringify({ model: "gpt", messages: [] }),
      headers: { authorization: "Bearer sk-real-key" },
    });

    expect(res.status).toBe(200);
    expect(errorCalls).toHaveLength(0);
    // Inner fetch saw the original request.
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("logs the full request + response body on a 4xx/5xx", async () => {
    const inner = vi.fn(async () =>
      jsonResponse(502, { error: { message: "Invalid grammar request" } }),
    );
    const { log, errorCalls } = fakeLogger();
    const wrapped = withFailureLogging(inner as unknown as typeof fetch, log, "openrouter");

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
    expect(errorCalls).toHaveLength(1);
    const entry = errorCalls[0]?.obj as {
      providerName: string;
      url: string;
      method: string;
      status: number;
      requestBody: string;
      responseBody: string;
      headers: Record<string, string>;
    };
    expect(entry.providerName).toBe("openrouter");
    expect(entry.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(entry.method).toBe("POST");
    expect(entry.status).toBe(502);
    expect(entry.requestBody).toBe(requestBody);
    expect(entry.responseBody).toContain("Invalid grammar request");
  });

  it("redacts authorization-style headers", async () => {
    const inner = vi.fn(async () => jsonResponse(400, { error: "bad request" }));
    const { log, errorCalls } = fakeLogger();
    const wrapped = withFailureLogging(inner as unknown as typeof fetch, log, "anthropic");

    await wrapped("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: "{}",
      headers: {
        authorization: "Bearer sk-real-key",
        "x-api-key": "sk-also-secret",
        "anthropic-api-key": "sk-also-secret",
        "content-type": "application/json",
      },
    });

    const headers = (errorCalls[0]?.obj as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe("[REDACTED]");
    expect(headers["x-api-key"]).toBe("[REDACTED]");
    expect(headers["anthropic-api-key"]).toBe("[REDACTED]");
    expect(headers["content-type"]).toBe("application/json");
    // No partial leak of the secret.
    expect(JSON.stringify(headers)).not.toContain("sk-real-key");
    expect(JSON.stringify(headers)).not.toContain("sk-also-secret");
  });

  it("truncates the request body at the 100KB limit with a marker", async () => {
    const inner = vi.fn(async () => jsonResponse(400, { error: "too big" }));
    const { log, errorCalls } = fakeLogger();
    const wrapped = withFailureLogging(inner as unknown as typeof fetch, log, "test");

    const huge = "x".repeat(200 * 1024); // 200KB
    await wrapped("https://example/v1/chat", { method: "POST", body: huge });

    const entry = errorCalls[0]?.obj as { requestBody: string };
    expect(entry.requestBody.length).toBeLessThan(huge.length);
    expect(entry.requestBody).toMatch(/\[truncated, full body \d+ bytes\]$/);
    expect(entry.requestBody.startsWith("x".repeat(100))).toBe(true);
  });

  it("logs and rethrows when the inner fetch throws", async () => {
    const networkErr = new Error("ECONNREFUSED");
    const inner = vi.fn(async () => {
      throw networkErr;
    });
    const { log, errorCalls } = fakeLogger();
    const wrapped = withFailureLogging(inner as unknown as typeof fetch, log, "openai");

    await expect(wrapped("https://example/v1/chat", { method: "POST", body: "{}" })).rejects.toBe(
      networkErr,
    );

    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]?.msg).toMatch(/threw/);
    const entry = errorCalls[0]?.obj as { err: unknown; requestBody: string };
    expect(entry.err).toBe(networkErr);
    expect(entry.requestBody).toBe("{}");
  });

  it("returns the original (unread) response body to the caller on failure", async () => {
    // Cloning behaviour: the body we logged must not consume the body the
    // SDK consumer needs. Confirms the consumer can still .json() the
    // response after our wrapper logged its content.
    const inner = vi.fn(async () => jsonResponse(429, { error: { code: "rate_limit" } }));
    const { log } = fakeLogger();
    const wrapped = withFailureLogging(inner as unknown as typeof fetch, log, "test");

    const res = await wrapped("https://example/v1/chat", { method: "POST", body: "{}" });
    const parsed = (await res.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe("rate_limit");
  });
});
