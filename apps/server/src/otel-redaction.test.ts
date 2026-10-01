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
/** A server that drops every connection, so a request to it fails the same way each run. */
let dropping: Server;
let droppingBase: string;

async function listen(target: Server): Promise<string> {
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "t", username: "t" } }),
    );
  });
  base = await listen(server);
  dropping = createServer();
  dropping.on("connection", (socket) => socket.destroy());
  droppingBase = await listen(dropping);
});

beforeEach(async () => {
  await harness.reset();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => dropping.close(() => resolve()));
  for (const instrumentation of instrumentations) instrumentation.disable();
  await harness.shutdown();
});

/** Everything a span would export that could carry text: name, status, attributes, events. */
function exportedText(span: ReadableSpan): string {
  return JSON.stringify({
    name: span.name,
    status: span.status,
    attributes: span.attributes,
    events: span.events,
  });
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
    const failure: unknown = await (await bot(droppingBase)).api.getMe().catch((e: unknown) => e);
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
      `${droppingBase}/bot<redacted>/getMe`,
    );
  });

  it("drops the query from undici spans, whatever its parameters are named", async () => {
    await (await fetch(`${base}/key.png?api_key=k3y&X-Amz-Signature=deadbeef`)).arrayBuffer();

    const undici = clientSpan("@opentelemetry/instrumentation-undici");
    expect(undici.attributes["url.full"]).toBe(`${base}/key.png`);
    expect(undici.attributes["url.path"]).toBe("/key.png");
    expect(undici.attributes).not.toHaveProperty("url.query");
    for (const span of harness.getSpans()) {
      expect(exportedText(span)).not.toContain("k3y");
      expect(exportedText(span)).not.toContain("deadbeef");
    }
  });

  it("keeps the path of other URLs as the instrumentations recorded it", async () => {
    await (await fetch(`${base}/v1/messages?beta=true`)).arrayBuffer();

    const span = clientSpan("@opentelemetry/instrumentation-undici");
    expect(span.attributes["url.full"]).toBe(`${base}/v1/messages`);
    expect(span.attributes["url.path"]).toBe("/v1/messages");
  });

  it("cuts every URL attribute at its query or fragment and drops query and fragment attributes", () => {
    trace
      .getTracer("test")
      .startSpan("caller", {
        attributes: {
          "url.full": `https://h.example/bot${FAKE_TOKEN}/k?token=t0k#frag`,
          "url.original": "https://h.example/k#access_token=t0k",
          "http.url": "https://h.example/k?token=t0k",
          "http.target": "/k?token=t0k",
          "url.query": "token=t0k",
          "url.fragment": "access_token=t0k",
          "url.path": "/k",
          "test.note": "query ?token=kept-in-free-text",
        },
      })
      .end();

    const span = expectDefined(harness.getSpans()[0], "span");
    expect(span.attributes).toEqual({
      "url.full": "https://h.example/bot<redacted>/k",
      "url.original": "https://h.example/k",
      "http.url": "https://h.example/k",
      "http.target": "/k",
      "url.path": "/k",
      "test.note": "query ?token=kept-in-free-text",
    });
  });

  it("redacts the token from a status message and exception text", () => {
    const message = `request to ${base}/bot${FAKE_TOKEN}/getMe failed`;
    trace.getTracer("test").startActiveSpan("caller", (span) => {
      span.recordException(new Error(message));
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.end();
    });

    const span = expectDefined(harness.getSpans()[0], "span");
    const redacted = `request to ${base}/bot<redacted>/getMe failed`;
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: redacted });
    expect(span.events[0]?.attributes?.["exception.message"]).toBe(redacted);
    expect(exportedText(span)).not.toContain(FAKE_SECRET);
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
