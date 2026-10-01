The Telegram bot token no longer reaches telemetry or logs. The Bot API carries the token in the URL path, so it was exported verbatim in HTTP client span URLs (`url.full`, and `url.path` on undici and server spans).

- **Spans.** The OTLP trace exporter is wrapped in `RedactingSpanExporter`, which replaces `bot<id>:<secret>` path segments with `bot<redacted>` in every exported span's name, attributes and event attributes, whichever instrumentation produced the span. grammY's Bot API calls arrive through `instrumentation-http` (node-fetch over `http`), and file downloads through `instrumentation-undici` (global `fetch`).
- **Signed query parameters.** The same wrapper redacts `X-Amz-Signature`, `sig` and the rest of `instrumentation-http`'s default list from URL attributes. That instrumentation already redacted them for its own spans, but `instrumentation-undici` didn't.
- **Logs.** pino's `streamWrite` hook applies the token redaction to every serialized line, so stdout and the OTLP log export see the same redacted line. The leak path was a logged grammY `HttpError`: pino's `err` serializer reaches the wrapped node-fetch error, whose message names the request URL.

See DEPLOYMENT.md → Observability → Secrets in URLs.
