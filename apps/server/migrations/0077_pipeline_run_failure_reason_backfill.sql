-- Carry the recorded text of every reason into `failure_detail`, then rewrite
-- `failure_reason` to the label the next migration casts it to. The labels
-- come from the writers' message shapes; a text none of them produced keeps
-- its status's generic reason, with the original text still in the detail.
UPDATE "pipeline_runs" SET "failure_detail" = "failure_reason"
WHERE "failure_reason" IS NOT NULL;--> statement-breakpoint
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
WHERE "status" NOT IN ('failed', 'cancelled');
