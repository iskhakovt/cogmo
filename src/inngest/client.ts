import { Inngest } from "inngest";

// Note on Inngest + OTel:
//
// The Inngest engine unconditionally opens an `inngest.execution` root span
// per function run via `trace.getTracer("inngest").startActiveSpan(...)` (see
// `inngest/components/execution/engine.js`). That span becomes the active
// context, and our domain spans (`chat`, `tool.execute`, `memory.recall`)
// parent under it via standard OTel propagation. We don't need any middleware
// for that.
//
// `extendedTracesMiddleware` from `inngest/experimental` adds a separate
// `InngestSpanProcessor` that sets `inngest.runId`/`traceref`/`step.*`
// attributes and exports to Inngest's own trace endpoint — but only when the
// function run is started with a `traceparent` on the request headers. We
// don't propagate `traceparent` through event payloads (see DEPLOYMENT.md →
// Observability for rationale), so the processor would be dormant. Skipping
// it keeps setup minimal; re-add if we adopt traceparent propagation.
export const inngest = new Inngest({
  id: "cogmo",
  isDev: process.env.INNGEST_DEV === "true" || process.env.INNGEST_DEV === "1",
});
