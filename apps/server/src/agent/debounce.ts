import { inngest } from "../inngest/client.js";
import { fromStepTools } from "../inngest/durable.js";
import {
  debounceCancel,
  debounceIdle,
  debounceMaxwait,
  inboundArrived,
} from "../inngest/events.js";
import { durableSleepSeconds } from "./debounce/durable-sleep.js";
import { emitNativeReady } from "./debounce/emit-native-ready.js";
import { fireDebounceTimer } from "./debounce/fire-debounce-timer.js";
import { routeInbound } from "./debounce/route-inbound.js";

export interface DebounceConfig {
  idleTimeoutMs: number; // 0 = disabled
  maxWaitMs: number; // 0 = disabled
  resumePolicy: "debounce" | "flush" | "await_input";
}

/**
 * Create debounce Inngest functions.
 *
 * Two paths, picked at construction time from `DebounceConfig`:
 *
 * 1. **Native fast path** — when `idleTimeoutMs >= 1000` (Inngest's minimum
 *    debounce period). The router carries Inngest's native `debounce` config
 *    keyed on `conversationId`, so duplicate `inbound/arrived` events for the
 *    same conversation collapse to one router run at the queue layer. No
 *    cancel listeners, no race window. The router then emits a single
 *    `inbound/ready`. Skips the idle/maxwait timer functions entirely.
 *
 * 2. **Legacy state machine** — for `idleTimeoutMs == 0` (no-debounce mode),
 *    sub-second timeouts, or maxwait-only configs that native debounce can't
 *    express (it requires `period`). The router fans out into `debounce-idle`
 *    + `debounce-maxwait`, with the documented cancel-listener race that
 *    handle-message's stale-trigger guard mops up after the fact. A
 *    sub-second timeout buys no extra responsiveness on this path either:
 *    durable sleeps have a one-second resolution (see `durableSleepMs`),
 *    so the wait matches what the native path would have given.
 *
 * Future direction (`design/transport/debounce.md` → "Future migration"):
 * if no realistic config ever falls outside the fast path's eligibility,
 * collapse to native-only and delete the legacy timer functions entirely.
 */
export function createDebounceFunctions(config: DebounceConfig) {
  if (canUseNativeDebounce(config)) {
    return [createNativeRouter(config)];
  }
  return createLegacyStateMachine(config);
}

/**
 * Native debounce requires `period >= 1s`. We map `idleTimeoutMs` to
 * `period` (idle reset on each event) and the optional `maxWaitMs` to
 * `timeout` (hard ceiling). `maxWaitMs == 0` is allowed — Inngest treats
 * a missing `timeout` as "no ceiling," matching legacy semantics.
 */
function canUseNativeDebounce(config: DebounceConfig): boolean {
  return config.idleTimeoutMs >= 1000 && (config.maxWaitMs === 0 || config.maxWaitMs >= 1000);
}

function msToSeconds(ms: number): `${number}s` {
  // Native debounce period/timeout types accept whole-second strings only.
  // Floor on the way down so "3500ms" debounces for 3s, not 4s — under-shooting
  // the configured idle is safer than over-shooting (more responsive UX).
  return `${durableSleepSeconds(ms)}s`;
}

function createNativeRouter(config: DebounceConfig) {
  return inngest.createFunction(
    {
      id: "debounce-router",
      triggers: [inboundArrived],
      debounce: {
        period: msToSeconds(config.idleTimeoutMs),
        ...(config.maxWaitMs > 0 && { timeout: msToSeconds(config.maxWaitMs) }),
        key: "event.data.conversationId",
      },
    },
    async ({ event, step }) =>
      emitNativeReady(fromStepTools(step), { ...event.data, triggeredAt: event.ts }),
  );
}

function createLegacyStateMachine(config: DebounceConfig) {
  const router = inngest.createFunction(
    { id: "debounce-router", triggers: [inboundArrived] },
    async ({ event, step }) =>
      routeInbound(fromStepTools(step), {
        ...event.data,
        idleTimeoutMs: config.idleTimeoutMs,
        maxWaitMs: config.maxWaitMs,
      }),
  );

  // Idle timer: cancelled by next debounce/idle (same conversation) — resets on each message.
  // KNOWN RACE: Inngest registers cancel listeners after the function starts,
  // so two debounce/idle events arriving within ~tens of milliseconds can both
  // complete (issue #121). The fast path above eliminates this; this code path
  // only runs for sub-second configs that can't use native debounce, where the
  // race window is small relative to the one-second minimum wait anyway.
  const idle = inngest.createFunction(
    {
      id: "debounce-idle",
      triggers: [debounceIdle],
      cancelOn: [
        { event: debounceIdle, match: "data.conversationId" },
        { event: debounceCancel, match: "data.conversationId" },
      ],
    },
    async ({ event, step }) => {
      await fireDebounceTimer(fromStepTools(step), { kind: "idle", ...event.data });
    },
  );

  // Maxwait timer: NOT cancelled by new messages — only by debounce/cancel.
  // Every message gets its own maxwait timer. Stale ones are rejected by the orchestrator.
  const maxwait = inngest.createFunction(
    {
      id: "debounce-maxwait",
      triggers: [debounceMaxwait],
      cancelOn: [{ event: debounceCancel, match: "data.conversationId" }],
    },
    async ({ event, step }) => {
      await fireDebounceTimer(fromStepTools(step), { kind: "maxwait", ...event.data });
    },
  );

  return [router, idle, maxwait];
}
