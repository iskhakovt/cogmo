import type { GetStepTools } from "inngest";
import type { inngest as inngestClient } from "./client.js";

export { inngest } from "./client.js";
export {
  codingTaskStart,
  directInbound,
  directOutbound,
  inboundArrived,
  responseReady,
} from "./events.js";

/**
 * The exact shape of `step.run` from the SDK — derived rather than re-typed
 * so it tracks Inngest version bumps (including `Jsonify<T>` return shape
 * and any middleware-aware transforms). Use as the type for orchestrator
 * deps that wrap `step.run` so unit tests can pass an inline shim.
 */
export type StepRun = GetStepTools<typeof inngestClient>["run"];

/**
 * The exact shape of `step.waitForEvent` — same derivation pattern as
 * `StepRun`. Used by orchestrators that block on Telegram callbacks.
 */
export type StepWaitForEvent = GetStepTools<typeof inngestClient>["waitForEvent"];
