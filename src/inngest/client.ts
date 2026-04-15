import { Inngest, type Middleware } from "inngest";
import { extendedTracesMiddleware } from "inngest/experimental";

// extendedTracesMiddleware bridges Inngest run/step spans into the active
// OTel provider when telemetry is configured. We gate on the same env flags
// as `src/otel.ts`: when OTel isn't initialized, set `"off"` so the middleware
// doesn't try to extend a provider that doesn't exist (which would emit
// noisy warnings on every test run).
//
// Cast: `extendedTracesMiddleware`'s factory return widens `maxAttempts` to
// `number | undefined`, which is incompatible with Inngest's own
// `BaseContext` under our `exactOptionalPropertyTypes: true`. Upstream type
// bug; runtime behaviour is correct.
const otelEnabled =
  !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.OTEL_SDK_DISABLED !== "true";
const otelMiddleware = extendedTracesMiddleware({
  behaviour: otelEnabled ? "extendProvider" : "off",
}) as unknown as Middleware.Class;

export const inngest = new Inngest({
  id: "cogmo",
  isDev: process.env.INNGEST_DEV === "true" || process.env.INNGEST_DEV === "1",
  middleware: [otelMiddleware],
});
