/**
 * Wire messages into the `ConnectorJobs` port's values: fresh and plain, with
 * every open enum value and `oneof` case the connector may send mapped to an
 * explicit fallback (`.agents/rules/protobuf.md`). The hub freezes them.
 */

import { JobErrorCode, type JobEvent, type JobResult, type Usage } from "@cogmo/connector-proto";
import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type {
  JobCompletion,
  JobFailureCode,
  JobReport,
  JobUsage,
} from "../agent/coding/connector-jobs.js";
import type { JobPhase } from "./caps.js";

/** The `JobResult` case each phase completes with. */
const RESULT_CASE = {
  prepare: "prepared",
  plan: "plan",
  execute: "executed",
  verify: "verify",
  publish: "published",
  release: "released",
} as const satisfies Record<JobPhase, NonNullable<JobResult["result"]["case"]>>;

/** Every code this build knows; a new `JobErrorCode` fails to compile until it is mapped. */
const FAILURE_CODE: Readonly<Record<JobErrorCode, JobFailureCode>> = {
  [JobErrorCode.UNSPECIFIED]: "unspecified",
  [JobErrorCode.AGENT_FAILED]: "agent_failed",
  [JobErrorCode.NO_PLAN]: "no_plan",
  [JobErrorCode.SESSION_LOST]: "session_lost",
  [JobErrorCode.BRANCH_CONFLICT]: "branch_conflict",
  [JobErrorCode.PUSH_AUTH_FAILED]: "push_auth_failed",
  [JobErrorCode.PUSH_FAILED]: "push_failed",
  [JobErrorCode.WORKSPACE_FAILED]: "workspace_failed",
  [JobErrorCode.JOB_CONFLICT]: "job_conflict",
  [JobErrorCode.UNSUPPORTED]: "unsupported",
};

/**
 * A completed job's result for `phase`. A result whose case doesn't match the
 * phase, or that misses an outcome it must carry, is the reason it is invalid.
 */
export function completionOf(phase: JobPhase, result: JobResult): Result<JobCompletion, string> {
  const expected = RESULT_CASE[phase];
  if (result.result.case !== expected) {
    return err(
      `a ${phase} job completes with a ${expected} result, not ${result.result.case ?? "none"}`,
    );
  }
  return match(result.result)
    .with({ case: "prepared" }, () => ok({ phase: "prepare" as const }))
    .with({ case: "plan" }, ({ value }) =>
      ok({ phase: "plan" as const, plan: value.plan, agentSessionId: value.agentSessionId }),
    )
    .with({ case: "executed" }, ({ value }) =>
      ok({ phase: "execute" as const, usage: value.usage ? usageOf(value.usage) : null }),
    )
    .with({ case: "verify" }, ({ value }) =>
      match(value.outcome)
        .with({ case: "exitCode" }, ({ value: exitCode }) =>
          ok({
            phase: "verify" as const,
            outcome: { kind: "exited" as const, exitCode },
            outputTail: value.outputTail,
          }),
        )
        .with({ case: "timedOut" }, () =>
          ok({
            phase: "verify" as const,
            outcome: { kind: "timed_out" as const },
            outputTail: value.outputTail,
          }),
        )
        .with({ case: undefined }, () => err("a verify verdict carries no outcome"))
        .exhaustive(),
    )
    .with({ case: "published" }, ({ value }) =>
      ok({ phase: "publish" as const, headSha: value.headSha }),
    )
    .with({ case: "released" }, ({ value }) =>
      match(value.outcome)
        .with({ case: "removedClean" }, () =>
          ok({ phase: "release" as const, outcome: { kind: "removed_clean" as const } }),
        )
        .with({ case: "salvagedAndRemoved" }, ({ value: salvaged }) =>
          ok({
            phase: "release" as const,
            outcome: {
              kind: "salvaged_and_removed" as const,
              salvageRef: salvaged.salvageRef,
              sha: salvaged.sha,
            },
          }),
        )
        .with({ case: "kept" }, ({ value: kept }) =>
          ok({
            phase: "release" as const,
            outcome: { kind: "kept" as const, reason: kept.reason },
          }),
        )
        .with({ case: undefined }, () => err("a release result carries no outcome"))
        .exhaustive(),
    )
    .exhaustive();
}

/** A connector's error code; a value this build does not know is `unknown`. */
export function failureCodeOf(code: JobErrorCode): JobFailureCode {
  return Object.hasOwn(FAILURE_CODE, code) ? FAILURE_CODE[code] : "unknown";
}

/** A reported event, or `null` for an event case this build does not know. */
export function reportOf(event: JobEvent): JobReport | null {
  return match(event.event)
    .with({ case: "textDelta" }, ({ value }) => ({ kind: "text_delta" as const, text: value }))
    .with({ case: "toolCall" }, ({ value }) => ({ kind: "tool_call" as const, name: value.name }))
    .with({ case: "toolResult" }, ({ value }) => ({
      kind: "tool_result" as const,
      name: value.name,
      ok: value.ok,
      summary: value.summary,
    }))
    .with({ case: "usage" }, ({ value }) => ({ kind: "usage" as const, usage: usageOf(value) }))
    .with({ case: undefined }, () => null)
    .exhaustive();
}

function usageOf(usage: Usage): JobUsage {
  return {
    inputTokens: usage.inputTokens === undefined ? null : Number(usage.inputTokens),
    outputTokens: usage.outputTokens === undefined ? null : Number(usage.outputTokens),
    costUsd: usage.costUsd ?? null,
  };
}
