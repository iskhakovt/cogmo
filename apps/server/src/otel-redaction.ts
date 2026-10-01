// Redaction applied to every span on its way out of the process. Loaded only
// by `otel.ts`, and only when telemetry is enabled.

import type { Attributes, AttributeValue } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter, TimedEvent } from "@opentelemetry/sdk-trace-base";
import {
  redactSecretsInText,
  redactSignedQuery,
  redactSignedQueryParams,
} from "./util/redact-secrets.js";

/**
 * Attributes whose value is a URL or part of one, across both HTTP semantic
 * convention generations, mapped to the signed-query redaction their shape
 * takes. Bot API token segments are redacted from every string attribute;
 * signed query parameters only from these.
 */
const QUERY_BEARING_ATTRIBUTES: ReadonlyMap<string, (value: string) => string> = new Map([
  ["url.full", redactSignedQueryParams],
  ["http.url", redactSignedQueryParams],
  ["http.target", redactSignedQueryParams],
  ["url.query", redactSignedQuery],
]);

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
 * any span a future instrumentation adds, and the span name and event
 * attributes (`exception.message`, `exception.stacktrace`) as well.
 *
 * Signed query parameters are redacted the way instrumentation-http already
 * does for its own spans; undici's instrumentation doesn't.
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
  const attributes = redactAttributes(span.attributes, QUERY_BEARING_ATTRIBUTES);
  const events = redactEvents(span.events);
  if (name === span.name && attributes === span.attributes && events === span.events) {
    return span;
  }
  return {
    name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext !== undefined && { parentSpanContext: span.parentSpanContext }),
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status,
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

/** `events` with secrets redacted from their attributes, or `events` itself when none changed. */
function redactEvents(events: TimedEvent[]): TimedEvent[] {
  let changed = false;
  const redacted = events.map((event) => {
    if (event.attributes === undefined) return event;
    const attributes = redactAttributes(event.attributes, NO_QUERY_REDACTIONS);
    if (attributes === event.attributes) return event;
    changed = true;
    return { ...event, attributes };
  });
  return changed ? redacted : events;
}

const NO_QUERY_REDACTIONS: ReadonlyMap<string, (value: string) => string> = new Map();

/**
 * `attributes` with secrets redacted, or `attributes` itself when nothing
 * changed. Token segments come out of every string (and string array
 * element); `queryRedactions` adds the signed-query pass for its keys.
 */
function redactAttributes(
  attributes: Attributes,
  queryRedactions: ReadonlyMap<string, (value: string) => string>,
): Attributes {
  let redacted: Attributes | undefined;
  for (const [key, value] of Object.entries(attributes)) {
    const next = redactValue(value, queryRedactions.get(key));
    if (next !== value) {
      redacted ??= { ...attributes };
      redacted[key] = next;
    }
  }
  return redacted ?? attributes;
}

function redactValue(
  value: AttributeValue | undefined,
  redactQuery: ((value: string) => string) | undefined,
): AttributeValue | undefined {
  if (typeof value === "string") {
    const scrubbed = redactSecretsInText(value);
    return redactQuery ? redactQuery(scrubbed) : scrubbed;
  }
  if (isStringArray(value)) {
    const next = value.map((item) => (typeof item === "string" ? redactSecretsInText(item) : item));
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
