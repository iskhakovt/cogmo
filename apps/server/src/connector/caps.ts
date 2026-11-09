/**
 * How long the hub waits on each kind of job (design/connectors.md → Jobs).
 */

import type { Job } from "@cogmo/connector-proto";
import { match } from "ts-pattern";

const MINUTE_MS = 60_000;

/** The longest delay `setTimeout` honours; a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** The spec cases of a `Job`, which name its phase. */
export type JobPhase = NonNullable<Job["spec"]["case"]>;

export interface JobCaps {
  /** From dispatch to the outcome. */
  totalMs: number;
  /** Between reports, once accepted; `null` when the job has no idle cap. */
  idleMs: number | null;
}

export function jobCaps(spec: Job["spec"]): JobCaps {
  return match(spec)
    .with({ case: "prepare" }, () => ({ totalMs: 10 * MINUTE_MS, idleMs: null }))
    .with({ case: "plan" }, { case: "execute" }, () => ({
      totalMs: 30 * MINUTE_MS,
      idleMs: 5 * MINUTE_MS,
    }))
    .with({ case: "verify" }, ({ value }) => ({
      totalMs: Math.min((value.timeoutSeconds + 60) * 1_000, MAX_TIMER_MS),
      idleMs: null,
    }))
    .with({ case: "publish" }, () => ({ totalMs: 5 * MINUTE_MS, idleMs: null }))
    .with({ case: "release" }, () => ({ totalMs: 10 * MINUTE_MS, idleMs: null }))
    .with({ case: undefined }, () => {
      throw new Error("a job has no spec");
    })
    .exhaustive();
}
