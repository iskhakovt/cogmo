Cogmo keeps the Telegram bot token out of telemetry and logs. The Bot API carries the token in the URL path, so every HTTP client span for a Telegram request records it in `url.full` (and undici and server spans in `url.path`), and node-fetch writes it into its error messages.

- **Spans.** The OTLP trace exporter is wrapped in `RedactingSpanExporter`, which replaces `bot<id>:<secret>` path segments with `bot<redacted>` in every exported span's name, status message, attributes and event attributes, whichever instrumentation produced the span. grammY's Bot API calls arrive through `instrumentation-http` (node-fetch over `http`), and file downloads through `instrumentation-undici` (global `fetch`).
- **Signed query parameters.** The same wrapper redacts the values of `X-Amz-Signature`, `sig` and the rest of `instrumentation-http`'s default list wherever a span carries them, in place, leaving other parameters as written. `instrumentation-http` already redacts them in its own `url.full`; `instrumentation-undici` doesn't.
- **Logs.** pino's `streamWrite` hook applies the token redaction to every serialized line, so stdout and the OTLP log export see the same redacted line. The leak path was a logged grammY `HttpError`: pino's `err` serializer reaches the wrapped node-fetch error, whose message names the request URL.

See DEPLOYMENT.md → Observability → Secrets in URLs.
