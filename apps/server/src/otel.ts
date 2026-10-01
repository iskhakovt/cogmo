// OpenTelemetry SDK init.
//
// Loaded as a Node import hook (`node --import ./otel.js dist/main.js`) so it
// runs before any instrumented module is resolved. ESM static imports are
// hoisted, so initializing OTel from the entrypoint's top-level imports is too
// late to patch http/undici/pino — the import hook is the supported pattern.
//
// Opt-in: when OTEL_EXPORTER_OTLP_ENDPOINT is unset we early-return without
// loading the SDK or any instrumentation modules. This keeps the default
// process lean (no extra ~10 MB RSS, no patching overhead) for users who
// don't want telemetry.

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.OTEL_SDK_DISABLED !== "true") {
  // Opt into the GenAI semantic conventions before the SDK reads env.
  // The conventions are still Development stability — explicit opt-in
  // tells the contrib instrumentations to emit `gen_ai.*` attributes.
  if (!process.env.OTEL_SEMCONV_STABILITY_OPT_IN) {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = "gen_ai_latest_experimental";
  }

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { PeriodicExportingMetricReader },
    { HttpInstrumentation },
    { UndiciInstrumentation },
    { PinoInstrumentation },
    { RedactingSpanExporter },
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-proto"),
    import("@opentelemetry/exporter-metrics-otlp-proto"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/instrumentation-http"),
    import("@opentelemetry/instrumentation-undici"),
    import("@opentelemetry/instrumentation-pino"),
    import("./otel-redaction.js"),
  ]);

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "cogmo",
    // Telegram's Bot API carries the bot token in the URL path, which every
    // HTTP client span records; the wrapper redacts it, and drops every URL's
    // query, before anything is exported. Log lines get the same
    // redaction in `logger.ts`, ahead of instrumentation-pino's log export.
    traceExporter: new RedactingSpanExporter(new OTLPTraceExporter()),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
    }),
    instrumentations: [
      new HttpInstrumentation(),
      new UndiciInstrumentation(),
      new PinoInstrumentation(),
    ],
  });

  sdk.start();

  const shutdown = async () => {
    try {
      await sdk.shutdown();
    } catch (err) {
      console.error("OTel shutdown failed", err);
    }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
