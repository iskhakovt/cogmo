/** What one liveness check reports (design/liveness.md → Surface). */

export type CheckStatus = "pass" | "warn";

/** One evaluation of a check. `observedValue` is in seconds. */
export type CheckReading =
  | { readonly status: "pass"; readonly observedValue: number | null }
  | {
      readonly status: "warn";
      /** A key from a fixed set: `/health`'s `reason`. */
      readonly reason: string;
      /** Fixed text and a normalized code, never platform text. */
      readonly output: string;
      readonly observedValue: number | null;
      /** Platform text for the verdict log line only; never leaves the process otherwise. */
      readonly detail: string | null;
    };

export type WarnReading = Extract<CheckReading, { status: "warn" }>;

/** One entry in the registry. */
export interface LivenessCheck {
  /** `{componentName}:{measurementName}`, the key `/health` groups entries under. */
  readonly check: string;
  /** Tells the entries under one key apart. */
  readonly componentId: string;
  /** Reads memory only. `now` is monotonic ms. A throw is a bug, reported as `check_error`. */
  evaluate(now: number): CheckReading;
}

const NUMERIC = /^\d+$/;
const SYSTEM_CODE = /^[A-Z][A-Z0-9_]*$/;
const FETCH_TYPE = /^[a-z][a-z-]*$/;

/** A code fit to leave the process: digits, a system code or a node-fetch `type`, else `unknown`. */
export function normalizeCode(code: string): string {
  return NUMERIC.test(code) || SYSTEM_CODE.test(code) || FETCH_TYPE.test(code) ? code : "unknown";
}

/** Whole seconds from `since` to `now`, both monotonic ms. */
export function ageSeconds(since: number, now: number): number {
  return Math.max(0, Math.floor((now - since) / 1000));
}
