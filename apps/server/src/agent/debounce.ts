import { inngest } from "../inngest/client.js";
import {
  debounceCancel,
  debounceIdle,
  debounceMaxwait,
  inboundArrived,
  inboundReady,
} from "../inngest/events.js";
import { debounceWaitMs } from "../metrics.js";

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
 *    durable sleeps have a one-second resolution (see {@link durableSleepMs}),
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

const MS_PER_SECOND = 1000;

/**
 * Whole seconds `step.sleep` will really wait for a requested duration.
 *
 * Inngest's durable waits have a one-second resolution. `step.sleep` runs its
 * argument through the SDK's `timeStr`, which decomposes the duration into
 * whole `w`/`d`/`h`/`m`/`s` units — there is no millisecond unit to carry a
 * remainder. So a positive duration below one second rounds up to one second,
 * and anything longer keeps only its whole seconds: a request for `"2500ms"`
 * is a two-second wait on the wire.
 */
function durableSleepSeconds(requestedMs: number): number {
  return Math.max(1, Math.floor(requestedMs / MS_PER_SECOND));
}

/**
 * The wait `step.sleep` will actually perform for a requested duration,
 * quantised to the resolution described on {@link durableSleepSeconds}.
 *
 * Timer handlers sleep for this value and record it on the histogram, so the
 * durable wait and the observed sample are the same number. Passing the raw
 * request through instead would leave the histogram claiming a precision the
 * platform cannot hold — a sub-second hold that never happened, or a
 * fractional-second tail that was dropped before the op left the SDK.
 *
 * Non-positive values pass through untouched: the resolution applies to
 * positive durations only, and a timeout of zero or less means the timer isn't
 * scheduled at all.
 */
export function durableSleepMs(requestedMs: number): number {
  if (requestedMs <= 0) return requestedMs;
  return durableSleepSeconds(requestedMs) * MS_PER_SECOND;
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
    async ({ event, step }) => {
      // Inngest hands us the LAST event in the burst (matching the legacy
      // semantics where the most recent inboundMessageId became triggerInboundId
      // via the idle timer's reset). The orchestrator loads all unbatched
      // inbound rows from the DB, so receiving only the last id is sufficient.
      const { conversationId, inboundMessageId } = event.data;
      // Approximate the legacy `kind: "idle" | "maxwait"` histogram by
      // recording the wall-clock gap between the trigger event's creation
      // and this handler running. This isn't the exact debounce sleep —
      // it's last-event-to-fire — but for an idle-dominated burst it's
      // close, and it preserves observability of "how long did debounce
      // hold this turn?" Native debounce doesn't expose internal timing,
      // so this proxy is the best we can do without instrumenting Inngest.
      if (typeof event.ts === "number") {
        debounceWaitMs.record(Math.max(0, Date.now() - event.ts), { kind: "native" });
      }
      await step.sendEvent(
        "ready",
        inboundReady.create({ conversationId, triggerInboundId: inboundMessageId }),
      );
      return { mode: "native" as const, triggerInboundId: inboundMessageId };
    },
  );
}

function createLegacyStateMachine(config: DebounceConfig) {
  const router = inngest.createFunction(
    { id: "debounce-router", triggers: [inboundArrived] },
    async ({ event, step }) => {
      const { conversationId, inboundMessageId } = event.data;
      // biome-ignore lint/suspicious/noExplicitAny: Inngest event types vary
      const events: any[] = [];

      if (config.idleTimeoutMs > 0) {
        events.push(
          debounceIdle.create({
            conversationId,
            inboundMessageId,
            timeoutMs: config.idleTimeoutMs,
          }),
        );
      }
      if (config.maxWaitMs > 0) {
        events.push(
          debounceMaxwait.create({
            conversationId,
            inboundMessageId,
            timeoutMs: config.maxWaitMs,
          }),
        );
      }

      // No debounce configured — fire immediately
      if (events.length === 0) {
        events.push(inboundReady.create({ conversationId, triggerInboundId: inboundMessageId }));
      }

      await step.sendEvent("route", events);
      return { mode: "legacy" as const, emitted: events.map((e) => e.name) };
    },
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
      // Sleep and histogram sample share one millisecond value, and it is a
      // whole number of seconds, so "how long did debounce hold this turn"
      // reads the same on the wire as in the metric. A configured duration
      // finer than one second is quantised by {@link durableSleepMs} first —
      // the metric reports the honoured wait, not the requested one.
      const ms = durableSleepMs(event.data.timeoutMs);
      await step.sleep("wait", `${ms}ms`);
      debounceWaitMs.record(ms, { kind: "idle" });
      await step.sendEvent(
        "fire",
        inboundReady.create({
          conversationId: event.data.conversationId,
          triggerInboundId: event.data.inboundMessageId,
        }),
      );
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
      const ms = durableSleepMs(event.data.timeoutMs);
      await step.sleep("wait", `${ms}ms`);
      debounceWaitMs.record(ms, { kind: "maxwait" });
      await step.sendEvent(
        "fire",
        inboundReady.create({
          conversationId: event.data.conversationId,
          triggerInboundId: event.data.inboundMessageId,
        }),
      );
    },
  );

  return [router, idle, maxwait];
}
