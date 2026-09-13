import { Inngest } from "inngest";
import { env } from "../env.js";

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
// `INNGEST_APP_ID` gives each integration test file a fresh app id. Files
// that run one after another in a worker slot share that slot's Inngest dev
// server, and a reused id would let a file take over runs the previous file
// left queued there.
//
// Keys come from `env`: `_FILE` values never reach the SDK's `process.env` fallback.
export const inngest = new Inngest({
  id: process.env.INNGEST_APP_ID ?? "cogmo",
  isDev: env.INNGEST_DEV,
  ...(env.INNGEST_EVENT_KEY !== undefined && { eventKey: env.INNGEST_EVENT_KEY }),
  ...(env.INNGEST_SIGNING_KEY !== undefined && { signingKey: env.INNGEST_SIGNING_KEY }),
});
