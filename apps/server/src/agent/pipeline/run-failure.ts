/**
 * Why a run ended. The reasons are the `pipeline_run_failure_reason` enum
 * split by the terminal status each belongs to (design/pipelines.md → Run
 * lifecycle); `detail` carries the variable part a reason has — an error
 * class, a validation message — and is null for the rest.
 */

import { match } from "ts-pattern";
import type {
  PIPELINE_RUN_CANCELLED_REASONS,
  PIPELINE_RUN_FAILED_REASONS,
} from "./store/schema.js";

export type PipelineRunFailedReason = (typeof PIPELINE_RUN_FAILED_REASONS)[number];
export type PipelineRunCancelledReason = (typeof PIPELINE_RUN_CANCELLED_REASONS)[number];

/** How a run came to be `failed`. */
export interface PipelineRunFailure {
  reason: PipelineRunFailedReason;
  detail: string | null;
}

/** How a run came to be `cancelled`. */
export interface PipelineRunCancellation {
  reason: PipelineRunCancelledReason;
  detail: string | null;
}

/** The failure as the run's conversation hears it. */
export function describePipelineRunFailure({ reason, detail }: PipelineRunFailure): string {
  const described = match(reason)
    .with("stage_error", () => "the stage failed")
    .with("unknown_stage", () => "the stage is not in the pinned definition")
    .with("unsupported_stage", () => "wait stages are not supported yet")
    .with("turn_degraded", () => "the stage's agent turn could not finish")
    .with("turn_truncated", () => "the stage's reply was cut off at the model's output limit")
    .with("artifact_invalid", () => "the stage's result did not match its declared output")
    .with("gate_resolution_error", () => "the checkpoint's timeout could not be applied")
    .exhaustive();
  return detail === null ? described : `${described} (${detail})`;
}
