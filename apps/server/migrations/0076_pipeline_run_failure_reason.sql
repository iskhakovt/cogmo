CREATE TYPE "public"."pipeline_run_failure_reason" AS ENUM('stage_error', 'unknown_stage', 'unsupported_stage', 'turn_degraded', 'turn_truncated', 'artifact_invalid', 'gate_resolution_error', 'cancelled_by_user', 'gate_timeout');--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "failure_detail" text;--> statement-breakpoint
-- Carry the recorded text of every failure into `failure_detail`, then rewrite
-- `failure_reason` to the label the cast below needs. The labels come from the
-- writers' message shapes; a text none of them produced keeps its status's
-- generic reason, with the original text still in the detail. A cancellation
-- carries no detail: its text named only the gate, which is `current_stage`.
UPDATE "pipeline_runs" SET "failure_detail" = "failure_reason"
WHERE "failure_reason" IS NOT NULL AND "status" <> 'cancelled';--> statement-breakpoint
UPDATE "pipeline_runs" SET "failure_reason" = CASE
  WHEN "status" = 'cancelled' THEN CASE
    WHEN "failure_reason" LIKE 'gate "%" timed out' THEN 'gate_timeout'
    ELSE 'cancelled_by_user'
  END
  WHEN "failure_reason" LIKE 'stage "%" is not in the pinned definition' THEN 'unknown_stage'
  WHEN "failure_reason" = 'wait stages are not supported yet' THEN 'unsupported_stage'
  WHEN "failure_reason" LIKE 'the stage''s agent turn could not finish (%)' THEN 'turn_degraded'
  WHEN "failure_reason" = 'the stage''s reply was cut off at the model''s output limit' THEN 'turn_truncated'
  WHEN "failure_reason" LIKE 'the stage''s result did not match its declared output: %' THEN 'artifact_invalid'
  WHEN "failure_reason" LIKE 'gate timeout could not be applied (%)' THEN 'gate_resolution_error'
  ELSE 'stage_error'
END
WHERE "status" IN ('failed', 'cancelled');--> statement-breakpoint
-- A reason on a run that is still moving is unrepresentable once the CHECK lands.
UPDATE "pipeline_runs" SET "failure_reason" = NULL, "failure_detail" = NULL
WHERE "status" NOT IN ('failed', 'cancelled');--> statement-breakpoint
ALTER TABLE "pipeline_runs" ALTER COLUMN "failure_reason" SET DATA TYPE "public"."pipeline_run_failure_reason" USING "failure_reason"::"public"."pipeline_run_failure_reason";--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "chk_pipeline_runs_failure_reason_by_status" CHECK (CASE "pipeline_runs"."status" WHEN 'failed' THEN "pipeline_runs"."failure_reason" IS NOT NULL AND "pipeline_runs"."failure_reason" IN ('stage_error', 'unknown_stage', 'unsupported_stage', 'turn_degraded', 'turn_truncated', 'artifact_invalid', 'gate_resolution_error') WHEN 'cancelled' THEN "pipeline_runs"."failure_reason" IS NOT NULL AND "pipeline_runs"."failure_reason" IN ('cancelled_by_user', 'gate_timeout') ELSE "pipeline_runs"."failure_reason" IS NULL AND "pipeline_runs"."failure_detail" IS NULL END);--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "chk_pipeline_runs_parked_gate_unclaimed" CHECK ("pipeline_runs"."status" <> 'waiting_gate' OR "pipeline_runs"."gate_resolution" IS NULL OR ("pipeline_runs"."gate_resolution" ->> 'gateKey') <> ("pipeline_runs"."id"::text || ':' || "pipeline_runs"."current_stage" || ':' || "pipeline_runs"."iteration"::text));