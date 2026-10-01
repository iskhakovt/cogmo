Cogmo keeps the Telegram bot token and query-string credentials out of telemetry and logs. The Bot API carries the token in the URL path, so every HTTP client span for a Telegram request recorded it in `url.full` (and undici and server spans in `url.path`), and node-fetch writes it into its error messages.

- **Spans.** The OTLP trace exporter is wrapped in `RedactingSpanExporter`. URL attributes lose their query and fragment, `url.query` and `url.fragment` are dropped, and `bot<id>:<secret>` path segments become `bot<redacted>` in every span's name, status message, attributes and event attributes, whichever instrumentation produced the span.
- **Logs.** pino's `streamWrite` hook applies the token redaction to every serialized line, so stdout and the OTLP log export see the same redacted line. The leak path was a logged grammY `HttpError`: pino's `err` serializer reaches the wrapped node-fetch error, whose message names the request URL.

See DEPLOYMENT.md → Observability → Secrets in URLs.
