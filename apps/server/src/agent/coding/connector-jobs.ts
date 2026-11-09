/**
 * The port coding stages run connector jobs through (design/connectors.md →
 * Data model). Boot wires it to the session hub in `src/connector/`. It takes
 * the protobuf `Job` a stage builds, whose spec the job id digests, and
 * returns plain, readonly values the hub translates from the wire and freezes:
 * they carry no protobuf representation, and a step can return them as they
 * are.
 */

import type { Job } from "@cogmo/connector-proto";
import type { Result } from "neverthrow";

export interface ConnectorJobs {
  /**
   * Dispatches `job` to the connector and resolves with how it ended. A
   * `job_id` the hub already holds sends nothing new: one in flight joins the
   * existing wait, and one that ended `completed`, `failed` or `cancelled`
   * returns that outcome. Only one that ended in a `JobRunError` is
   * dispatched again.
   */
  run(
    connectorId: string,
    job: Job,
    handlers: JobEventHandlers,
  ): Promise<Result<JobOutcome, JobRunError>>;
}

export interface JobEventHandlers {
  /** Each reported event once, in the order the connector reported it. */
  onEvent(event: JobReport): void;
}

/** What a running job reports. */
export type JobReport =
  | { readonly kind: "text_delta"; readonly text: string }
  | { readonly kind: "tool_call"; readonly name: string }
  | {
      readonly kind: "tool_result";
      readonly name: string;
      readonly ok: boolean;
      readonly summary: string;
    }
  | { readonly kind: "usage"; readonly usage: JobUsage };

/** Cumulative usage for a job; `null` where the runtime reports none. */
export interface JobUsage {
  /** Input not read from or written to the prompt cache. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
}

/** How the connector ended the job. */
export type JobOutcome =
  | { readonly kind: "completed"; readonly result: JobCompletion }
  | { readonly kind: "failed"; readonly code: JobFailureCode; readonly message: string }
  | { readonly kind: "cancelled" };

/** A completed job's result; the hub has checked its phase matches the job's spec. */
export type JobCompletion =
  | { readonly phase: "prepare" }
  | { readonly phase: "plan"; readonly plan: string; readonly agentSessionId: string }
  | { readonly phase: "execute"; readonly usage: JobUsage | null }
  | {
      readonly phase: "verify";
      readonly outcome: VerifyOutcome;
      /** The end of the combined output, at most 8 KiB. */
      readonly outputTail: string;
    }
  | { readonly phase: "publish"; readonly headSha: string }
  | { readonly phase: "release"; readonly outcome: ReleaseOutcome };

export type VerifyOutcome =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "timed_out" };

export type ReleaseOutcome =
  | { readonly kind: "removed_clean" }
  | { readonly kind: "salvaged_and_removed"; readonly salvageRef: string; readonly sha: string }
  | { readonly kind: "kept"; readonly reason: string };

/**
 * Why the connector failed the job. `unspecified` is a failure the connector
 * gave no code for; `unknown` is a code this build does not know.
 */
export type JobFailureCode =
  | "agent_failed"
  | "no_plan"
  | "session_lost"
  | "branch_conflict"
  | "push_auth_failed"
  | "push_failed"
  | "workspace_failed"
  | "job_conflict"
  | "unsupported"
  | "unspecified"
  | "unknown";

/** How the hub gave up on the job. */
export type JobRunError =
  | { readonly kind: "unavailable" }
  | { readonly kind: "lost" }
  | { readonly kind: "timed_out"; readonly cap: JobCap }
  /** The connector finished the job with a result that doesn't fit its spec. */
  | { readonly kind: "invalid_result"; readonly message: string };

export type JobCap = "total" | "idle" | "token_budget";
