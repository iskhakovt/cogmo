/**
 * The port coding stages run connector jobs through (design/connectors.md →
 * Data model). Boot wires it to the session hub in `src/connector/`.
 */

import type { Job, JobError, JobEvent, JobResult } from "@cogmo/connector-proto";
import type { Result } from "neverthrow";

export interface ConnectorJobs {
  /**
   * Dispatches `job` to the connector and resolves with how it ended. A
   * `job_id` the hub already holds sends nothing new: one in flight joins the
   * existing wait, and one that ended `completed`, `failed` or `cancelled`
   * returns that outcome. Only one that ended `timed_out`, `lost` or
   * `unavailable` is dispatched again.
   */
  run(
    connectorId: string,
    job: Job,
    handlers: JobEventHandlers,
  ): Promise<Result<JobOutcome, JobRunError>>;
}

export interface JobEventHandlers {
  /** Each reported event once, in `seq` order. */
  onEvent(event: JobEvent): void;
}

/** How the connector ended the job. */
export type JobOutcome =
  | { kind: "completed"; result: JobResult }
  | { kind: "failed"; error: JobError }
  | { kind: "cancelled" };

/** How the hub gave up on the job. */
export type JobRunError =
  | { kind: "unavailable" }
  | { kind: "lost" }
  | { kind: "timed_out"; cap: JobCap };

export type JobCap = "total" | "idle" | "token_budget";
