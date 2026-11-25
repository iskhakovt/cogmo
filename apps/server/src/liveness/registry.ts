/**
 * The in-process check registry: every check evaluated on a tick, read by
 * `/health`, the `cogmo.check.status` gauge and one log line per verdict
 * change (design/liveness.md → Surface).
 */

import type { Meter, ObservableCallback, ObservableGauge } from "@opentelemetry/api";
import { match } from "ts-pattern";
import { logger } from "../logger.js";
import type { CheckReading, CheckStatus, LivenessCheck, WarnReading } from "./check.js";

/** One entry's last evaluation. */
export interface CheckResult {
  readonly check: string;
  readonly componentId: string;
  readonly reading: CheckReading;
  /** Wall-clock time of the evaluation. */
  readonly time: Date;
}

/** What `/health` reads: the last tick, from memory. */
export interface LivenessReadings {
  /** `warn` when any entry warns. */
  status(): CheckStatus;
  results(): ReadonlyArray<CheckResult>;
}

/** The registry `cogmo serve` holds: its readings, and the tick shutdown stops. */
export interface Liveness extends LivenessReadings {
  /** Clear the tick and detach the gauge. Idempotent. */
  stop(): void;
}

export interface LivenessClock {
  /** Monotonic ms, the clock every check's ages are on. */
  monotonic(): number;
  wall(): Date;
}

export const SYSTEM_CLOCK: LivenessClock = {
  monotonic: () => performance.now(),
  wall: () => new Date(),
};

export const LIVENESS_TICK_MS = 15_000;

export interface LivenessRegistryOptions {
  meter: Meter;
  tickMs: number;
  clock: LivenessClock;
}

const CHECK_ERROR: WarnReading = {
  status: "warn",
  reason: "check_error",
  output: "check_error: the check threw",
  observedValue: null,
  detail: null,
};

type Evaluation =
  | { readonly kind: "evaluated"; readonly reading: CheckReading }
  /** A bug in the check, reported as `check_error`. */
  | { readonly kind: "threw"; readonly err: unknown };

function evaluate(check: LivenessCheck, now: number): Evaluation {
  try {
    return { kind: "evaluated", reading: check.evaluate(now) };
  } catch (err) {
    return { kind: "threw", err };
  }
}

function readingOf(evaluation: Evaluation): CheckReading {
  return match(evaluation)
    .with({ kind: "evaluated" }, ({ reading }) => reading)
    .with({ kind: "threw" }, () => CHECK_ERROR)
    .exhaustive();
}

/** A change of status, or of reason under `warn`. A first reading changes the verdict only by warning. */
function verdictChanged(previous: CheckReading | undefined, next: CheckReading): boolean {
  if (previous === undefined) return next.status === "warn";
  if (previous.status === "warn" && next.status === "warn") return previous.reason !== next.reason;
  return previous.status !== next.status;
}

function warnFields(reading: WarnReading) {
  return {
    reason: reading.reason,
    output: reading.output,
    ...(reading.detail !== null && { detail: reading.detail }),
  };
}

function logVerdict(check: LivenessCheck, evaluation: Evaluation): void {
  const entry = { check: check.check, componentId: check.componentId };
  match(evaluation)
    .with({ kind: "threw" }, ({ err }) =>
      logger.error({ ...entry, ...warnFields(CHECK_ERROR), err }, "liveness check warn"),
    )
    .with({ kind: "evaluated", reading: { status: "warn" } }, ({ reading }) =>
      logger.warn({ ...entry, ...warnFields(reading) }, "liveness check warn"),
    )
    .with({ kind: "evaluated", reading: { status: "pass" } }, () =>
      logger.info(entry, "liveness check pass"),
    )
    .exhaustive();
}

export class LivenessRegistry implements Liveness {
  readonly #checks: ReadonlyArray<LivenessCheck>;
  readonly #clock: LivenessClock;
  readonly #gauge: ObservableGauge;
  readonly #observe: ObservableCallback;
  #results: ReadonlyArray<CheckResult> = [];
  #timer: NodeJS.Timeout | null = null;

  private constructor(checks: ReadonlyArray<LivenessCheck>, opts: LivenessRegistryOptions) {
    this.#checks = checks;
    this.#clock = opts.clock;
    this.#gauge = opts.meter.createObservableGauge("cogmo.check.status", {
      description:
        "Each liveness check's status as a state set: 1 for its current status, 0 for the other",
    });
    // A state set after `hw.status`: both series per entry, every export.
    this.#observe = (observer) => {
      for (const { check, componentId, reading } of this.#results) {
        for (const status of ["pass", "warn"] as const) {
          observer.observe(reading.status === status ? 1 : 0, {
            check,
            component_id: componentId,
            status,
          });
        }
      }
    };
  }

  /** Build the registry, evaluate every check once, and tick every `tickMs` until `stop()`. */
  static start(
    checks: ReadonlyArray<LivenessCheck>,
    opts: LivenessRegistryOptions,
  ): LivenessRegistry {
    const registry = new LivenessRegistry(checks, opts);
    registry.#tick();
    registry.#gauge.addCallback(registry.#observe);
    registry.#timer = setInterval(() => registry.#tick(), opts.tickMs).unref();
    return registry;
  }

  status(): CheckStatus {
    return this.#results.some(({ reading }) => reading.status === "warn") ? "warn" : "pass";
  }

  /** Replaced whole on each tick, never mutated, so the caller's copy stays as read. */
  results(): ReadonlyArray<CheckResult> {
    return this.#results;
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
    this.#gauge.removeCallback(this.#observe);
  }

  #tick(): void {
    const now = this.#clock.monotonic();
    const time = this.#clock.wall();
    // An entry keeps its index across ticks: the check list is fixed at construction.
    const evaluated = this.#checks.map((check, i) => ({
      check,
      evaluation: evaluate(check, now),
      previous: this.#results[i]?.reading,
    }));
    for (const { check, evaluation, previous } of evaluated) {
      if (verdictChanged(previous, readingOf(evaluation))) logVerdict(check, evaluation);
    }
    this.#results = evaluated.map(({ check, evaluation }) => ({
      check: check.check,
      componentId: check.componentId,
      reading: readingOf(evaluation),
      time,
    }));
  }
}
