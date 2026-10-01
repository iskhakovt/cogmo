import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { RedactingSpanExporter } from "./otel-redaction.js";
import { expectDefined } from "./test/assertions.js";
import { setupOtelHarness } from "./test/otel-harness.js";

/** Shaped like a Bot API token (numeric id, colon, URL-safe base64), but not one. */
const FAKE_SECRET = "AAFake-TokenForTests_0123456789abcdef";
const FAKE_TOKEN = `123456789:${FAKE_SECRET}`;

// The harness and the instrumentations go in before grammY or any request is
// loaded or made: instrumentation-http patches `http` as it is required, and
// the tracer is resolved through the global provider the harness installs.
const harness = setupOtelHarness({ wrapExporter: (inner) => new RedactingSpanExporter(inner) });
const instrumentations = [new HttpInstrumentation(), new UndiciInstrumentation()];

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "t", username: "t" } }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await harness.reset();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const instrumentation of instrumentations) instrumentation.disable();
  await harness.shutdown();
});

/** Everything a span would export that could carry text: name, attributes, events. */
function exportedText(span: ReadableSpan): string {
  return JSON.stringify({ name: span.name, attributes: span.attributes, events: span.events });
}

function clientSpan(scope: string): ReadableSpan {
  return expectDefined(
    harness
      .getSpans()
      .find((s) => s.kind === SpanKind.CLIENT && s.instrumentationScope.name === scope),
    `${scope} client span`,
  );
}

/** A grammY client for the local server, which answers every method with `ok`. */
async function bot(apiRoot: string) {
  const { Bot } = await import("grammy");
  return new Bot(FAKE_TOKEN, { client: { apiRoot } });
}

describe("RedactingSpanExporter with the HTTP instrumentations", () => {
  it("redacts the token from a grammY Bot API call, which runs through instrumentation-http", async () => {
    await (await bot(base)).api.getMe();

    const spans = harness.getSpans();
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) expect(exportedText(span)).not.toContain(FAKE_SECRET);
    // grammY's node-fetch goes over `http`, so the client span is
    // instrumentation-http's; the local server's span carries the path too.
    expect(clientSpan("@opentelemetry/instrumentation-http").attributes["url.full"]).toBe(
      `${base}/bot<redacted>/getMe`,
    );
    const serverSpan = expectDefined(
      spans.find((s) => s.kind === SpanKind.SERVER),
      "server span",
    );
    expect(serverSpan.attributes["url.path"]).toBe("/bot<redacted>/getMe");
  });

  it("redacts the token from a file download, which runs through instrumentation-undici", async () => {
    await (await fetch(`${base}/file/bot${FAKE_TOKEN}/photos/file_7.jpg`)).arrayBuffer();

    for (const span of harness.getSpans()) expect(exportedText(span)).not.toContain(FAKE_SECRET);
    const span = clientSpan("@opentelemetry/instrumentation-undici");
    expect(span.attributes["url.full"]).toBe(`${base}/file/bot<redacted>/photos/file_7.jpg`);
    expect(span.attributes["url.path"]).toBe("/file/bot<redacted>/photos/file_7.jpg");
  });

  it("redacts the token from a failed call's span and recorded exception", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const failure: unknown = await (await bot(`http://127.0.0.1:${port}`)).api
      .getMe()
      .catch((e: unknown) => e);
    const { HttpError } = await import("grammy");
    if (!(failure instanceof HttpError) || !(failure.error instanceof Error)) {
      throw new Error("expected grammY to throw an HttpError wrapping node-fetch's error");
    }
    const fetchError = failure.error;
    // grammY keeps node-fetch's error, whose message names the URL, on
    // `HttpError.error`; record it the way a caller's span would.
    trace.getTracer("test").startActiveSpan("caller", (span) => {
      span.recordException(fetchError);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    });

    expect(fetchError.message).toContain(FAKE_SECRET);
    const spans = harness.getSpans();
    for (const span of spans) expect(exportedText(span)).not.toContain(FAKE_SECRET);
    const caller = expectDefined(
      spans.find((s) => s.name === "caller"),
      "caller span",
    );
    expect(caller.events[0]?.attributes?.["exception.message"]).toContain("/bot<redacted>/getMe");
    expect(clientSpan("@opentelemetry/instrumentation-http").attributes["url.full"]).toBe(
      `http://127.0.0.1:${port}/bot<redacted>/getMe`,
    );
  });

  it("redacts signed query parameters from undici spans, as instrumentation-http does for its own", async () => {
    const signed = "/key.png?X-Amz-Credential=AKIDFAKE&X-Amz-Signature=deadbeef&keep=1";
    await (await fetch(`${base}${signed}`)).arrayBuffer();

    const undici = clientSpan("@opentelemetry/instrumentation-undici");
    expect(undici.attributes["url.full"]).toBe(
      `${base}/key.png?X-Amz-Credential=REDACTED&X-Amz-Signature=REDACTED&keep=1`,
    );
    expect(undici.attributes["url.query"]).toBe(
      "?X-Amz-Credential=REDACTED&X-Amz-Signature=REDACTED&keep=1",
    );
    for (const span of harness.getSpans()) {
      expect(exportedText(span)).not.toContain("deadbeef");
      expect(exportedText(span)).not.toContain("AKIDFAKE");
    }
  });

  it("leaves other URLs as the instrumentations recorded them", async () => {
    await (await fetch(`${base}/v1/messages?beta=true&q=a%20b`)).arrayBuffer();

    const span = clientSpan("@opentelemetry/instrumentation-undici");
    expect(span.attributes["url.full"]).toBe(`${base}/v1/messages?beta=true&q=a%20b`);
    expect(span.attributes["url.path"]).toBe("/v1/messages");
    expect(span.attributes["url.query"]).toBe("?beta=true&q=a%20b");
  });

  it("redacts a span name and string array attributes", async () => {
    const tracer = trace.getTracer("test");
    tracer
      .startSpan(`GET /bot${FAKE_TOKEN}/getMe`, {
        attributes: { "test.urls": [`/bot${FAKE_TOKEN}/a`, "/plain"], "test.count": 2 },
      })
      .end();

    const span = expectDefined(harness.getSpans()[0], "span");
    expect(span.name).toBe("GET /bot<redacted>/getMe");
    expect(span.attributes["test.urls"]).toEqual(["/bot<redacted>/a", "/plain"]);
    expect(span.attributes["test.count"]).toBe(2);
  });
});

describe("RedactingSpanExporter delegation", () => {
  function recordedSpan(): ReadableSpan {
    trace
      .getTracer("test")
      .startSpan("plain", { attributes: { "url.full": "https://h/p" } })
      .end();
    return expectDefined(harness.getSpans()[0], "span");
  }

  it("hands spans with nothing to redact to the inner exporter as they are", () => {
    const span = recordedSpan();
    const inner = mock<SpanExporter>();
    const callback = (): void => {};

    new RedactingSpanExporter(inner).export([span], callback);

    expect(inner.export).toHaveBeenCalledWith([span], callback);
    expect(inner.export.mock.calls[0]?.[0][0]).toBe(span);
  });

  it("delegates shutdown and forceFlush", async () => {
    const shutdown = vi.fn(async () => {});
    const forceFlush = vi.fn(async () => {});
    const exporter = new RedactingSpanExporter({ export: vi.fn(), shutdown, forceFlush });

    await exporter.forceFlush();
    await exporter.shutdown();

    expect(forceFlush).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("resolves forceFlush when the inner exporter has none", async () => {
    const inner: SpanExporter = { export: () => {}, shutdown: async () => {} };

    await expect(new RedactingSpanExporter(inner).forceFlush()).resolves.toBeUndefined();
  });
});
