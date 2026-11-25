/** Channel entries: a receive loop's verdict, and a row this build can't serve (design/liveness.md → Verdict and thresholds). */

import { match, P } from "ts-pattern";
import type { ChannelError, ChannelLiveness, LoopState, RetryCause } from "../transport/types.js";
import { ageSeconds, type CheckReading, type LivenessCheck, normalizeCode } from "./check.js";

type FailedReason = Extract<LoopState, { kind: "failed" }>["reason"];

const FAILED_TEXT: Readonly<Record<FailedReason, string>> = {
  unauthorized: "the platform refused the channel's credentials",
  rejected: "the platform rejected the receive loop",
  ended: "the receive loop ended without stop()",
};

const RETRY_TEXT: Readonly<Record<RetryCause, string>> = {
  conflict: "another poller or a webhook holds the token",
  network: "a network error",
  rate_limited: "rate limiting",
  server_error: "a server error",
  client_error: "a client error",
  bad_reply: "an unexpected reply",
  unknown: "an unknown error",
};

function withCode(text: string, error: ChannelError | null): string {
  return error === null ? text : `${text} (${normalizeCode(error.code)})`;
}

function warn(
  reason: string,
  text: string,
  observedValue: number,
  error: ChannelError | null,
): CheckReading {
  return {
    status: "warn",
    reason,
    output: `${reason}: ${withCode(text, error)}`,
    observedValue,
    detail: error?.detail ?? null,
  };
}

/** A receive loop's reading at monotonic `now`; the first matching row of the verdict table decides. */
export function channelCheck(liveness: ChannelLiveness, now: number): CheckReading {
  const { progressAt, handlingSince, conflicts, thresholds } = liveness;
  const observedValue = ageSeconds(progressAt, now);
  return match(liveness.state)
    .returnType<CheckReading>()
    .with({ kind: "failed" }, ({ reason, error }) =>
      warn("failed", FAILED_TEXT[reason], observedValue, error),
    )
    .with({ kind: "stopped" }, () => ({ status: "pass", observedValue }))
    .with({ kind: P.union("starting", "receiving", "retrying") }, (state) => {
      const retryError = state.kind === "retrying" ? state.error : null;
      if (handlingSince !== null && now - handlingSince >= thresholds.wedgedAfterMs) {
        return warn("wedged", "an update has been in hand too long", observedValue, null);
      }
      if (conflicts >= 2) {
        return warn("flapping", RETRY_TEXT.conflict, observedValue, retryError);
      }
      if (state.kind === "retrying" && now - state.since >= thresholds.staleAfterMs) {
        return warn("retrying", `after ${RETRY_TEXT[state.cause]}`, observedValue, state.error);
      }
      if (handlingSince === null && now - progressAt >= thresholds.staleAfterMs) {
        return warn("stale", "no reply or update for too long", observedValue, null);
      }
      return { status: "pass", observedValue };
    })
    .exhaustive();
}

/** A started channel, as `startChannels` reports it. */
export interface StartedChannel {
  readonly channelType: string;
  readonly channelId: string;
  readonly adapter: { liveness(): ChannelLiveness | null };
}

/** A channel row whose type this build has no adapter for. */
export interface UnsupportedChannel {
  readonly channelType: string;
  readonly channelId: string;
}

const UNSUPPORTED: CheckReading = {
  status: "warn",
  reason: "unsupported",
  output: "unsupported: this build has no adapter for the channel's type",
  observedValue: null,
  detail: null,
};

/**
 * One `{type}:polling` entry per started channel with a receive loop, and a
 * `channels:adapter` entry per unsupported row. An adapter whose `liveness()`
 * is null has no loop and no entry.
 */
export function channelChecks(
  started: ReadonlyArray<StartedChannel>,
  unsupported: ReadonlyArray<UnsupportedChannel>,
): ReadonlyArray<LivenessCheck> {
  const loops = started
    .filter(({ adapter }) => adapter.liveness() !== null)
    .map(
      ({ channelType, channelId, adapter }): LivenessCheck => ({
        check: `${channelType}:polling`,
        componentId: channelId,
        evaluate(now) {
          const liveness = adapter.liveness();
          if (liveness === null) {
            throw new Error(`${channelType} adapter's liveness() went null after reporting a loop`);
          }
          return channelCheck(liveness, now);
        },
      }),
    );
  const rows = unsupported.map(
    ({ channelId }): LivenessCheck => ({
      check: "channels:adapter",
      componentId: channelId,
      evaluate: () => UNSUPPORTED,
    }),
  );
  return [...loops, ...rows];
}
