// Redaction applied to every span on its way out of the process. Loaded only
// by `otel.ts`, and only when telemetry is enabled.

import type { Attributes, AttributeValue, SpanStatus } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter, TimedEvent } from "@opentelemetry/sdk-trace-base";
import { redactSecretsInText } from "./util/redact-secrets.js";

/**
 * Attributes that hold only a query or fragment, which can carry a signature
 * or credential under any name. Dropped from every span.
 */
const DROPPED_KEYS: ReadonlySet<string> = new Set(["url.query", "url.fragment"]);

/**
 * Attributes that hold a whole URL or a request target (path plus query), in
 * both HTTP semantic convention generations. Exported without their query or
 * fragment, as `url.path` already is.
 */
const URL_KEYS: ReadonlySet<string> = new Set([
  "url.full",
  "url.original",
  "http.url",
  "http.target",
]);

/** `url` cut at its query or fragment, with Bot API token segments redacted. */
function redactUrl(url: string): string {
  const end = url.search(/[?#]/);
  return redactSecretsInText(end === -1 ? url : url.slice(0, end));
}

/**
 * A `SpanExporter` that redacts secrets carried in URLs before handing spans
 * to the exporter it wraps — the one point every span passes through on its
 * way out, whichever instrumentation or HTTP stack produced it.
 *
 * Telegram's Bot API puts the bot token in the URL path, so every Bot API
 * client span carries it in `url.full` (and `url.path` on undici and server
 * spans). grammY's calls go through node-fetch over `http` and arrive via
 * `@opentelemetry/instrumentation-http`; global `fetch` (file downloads) goes
 * through undici and arrives via `@opentelemetry/instrumentation-undici`.
 * Redacting here rather than in either instrumentation's hooks covers both,
 * any span a future instrumentation adds, and the span name, status message
 * and event attributes (`exception.message`, `exception.stacktrace`) as well.
 *
 * Queries are dropped rather than scrubbed by parameter name: a credential
 * can sit under any name (`key`, `token`, a presigned URL's signature), and
 * which endpoint a span called is in the path, not the query. Free text —
 * span names, status messages, `exception.*` — has only the token segment
 * redacted; a URL embedded in prose has no reliable end to cut at.
 */
export class RedactingSpanExporter implements SpanExporter {
  readonly #inner: SpanExporter;

  constructor(inner: SpanExporter) {
    this.#inner = inner;
  }

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    this.#inner.export(spans.map(redactSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.#inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.#inner.forceFlush?.() ?? Promise.resolve();
  }
}

/** `span` with its secrets redacted, or `span` itself when it carries none. */
function redactSpan(span: ReadableSpan): ReadableSpan {
  const name = redactSecretsInText(span.name);
  const status = redactStatus(span.status);
  const attributes = redactAttributes(span.attributes);
  const events = redactEvents(span.events);
  if (
    name === span.name &&
    status === span.status &&
    attributes === span.attributes &&
    events === span.events
  ) {
    return span;
  }
  return {
    name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext !== undefined && { parentSpanContext: span.parentSpanContext }),
    startTime: span.startTime,
    endTime: span.endTime,
    status,
    attributes,
    links: span.links,
    events,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/** `status` with its message redacted, or `status` itself when it carries no secret. */
function redactStatus(status: SpanStatus): SpanStatus {
  if (status.message === undefined) return status;
  const message = redactSecretsInText(status.message);
  return message === status.message ? status : { ...status, message };
}

/** `events` with secrets redacted from their attributes, or `events` itself when none changed. */
function redactEvents(events: TimedEvent[]): TimedEvent[] {
  let changed = false;
  const redacted = events.map((event) => {
    if (event.attributes === undefined) return event;
    const attributes = redactAttributes(event.attributes);
    if (attributes === event.attributes) return event;
    changed = true;
    return { ...event, attributes };
  });
  return changed ? redacted : events;
}

/**
 * `attributes` without query and fragment attributes, with URL attributes cut
 * at their query and every other string (and string array element) token
 * redacted, or `attributes` itself when nothing changed.
 */
function redactAttributes(attributes: Attributes): Attributes {
  let redacted: Attributes | undefined;
  for (const [key, value] of Object.entries(attributes)) {
    if (DROPPED_KEYS.has(key)) {
      redacted ??= { ...attributes };
      delete redacted[key];
      continue;
    }
    const next = redactValue(value, URL_KEYS.has(key) ? redactUrl : redactSecretsInText);
    if (next !== value) {
      redacted ??= { ...attributes };
      redacted[key] = next;
    }
  }
  return redacted ?? attributes;
}

/**
 * `value` with `redact` applied to it, or to each string element. The SDK
 * keeps only homogeneous arrays (`isAttributeValue` in `@opentelemetry/core`),
 * so an array holding a string holds nothing but strings and nulls.
 */
function redactValue(
  value: AttributeValue | undefined,
  redact: (text: string) => string,
): AttributeValue | undefined {
  if (typeof value === "string") return redact(value);
  if (isStringArray(value)) {
    const next = value.map((item) => (typeof item === "string" ? redact(item) : item));
    return next.some((item, i) => item !== value[i]) ? next : value;
  }
  return value;
}

function isStringArray(
  value: AttributeValue | undefined,
): value is Array<string | null | undefined> {
  return (
    Array.isArray(value) &&
    value.some((item) => typeof item === "string") &&
    value.every((item) => item === null || item === undefined || typeof item === "string")
  );
}
