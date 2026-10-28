ALTER TABLE "skill_deploys" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."skill_deploy_status";--> statement-breakpoint
CREATE TYPE "public"."skill_deploy_status" AS ENUM('pending_approval', 'denied', 'live', 'rolled_back');--> statement-breakpoint
ALTER TABLE "skill_deploys" ALTER COLUMN "status" SET DATA TYPE "public"."skill_deploy_status" USING "status"::"public"."skill_deploy_status";--> statement-breakpoint
ALTER TABLE "skill_deploys" ADD CONSTRAINT "chk_skill_deploys_resolved_at_iff_terminal" CHECK (("skill_deploys"."status" = 'pending_approval') = ("skill_deploys"."resolved_at" IS NULL));--> statement-breakpoint
ALTER TABLE "skill_deploys" ADD CONSTRAINT "chk_skill_deploys_approved_by_only_live" CHECK ("skill_deploys"."approved_by" IS NULL OR "skill_deploys"."status" = 'live');--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "chk_skill_runs_status_iff_finished" CHECK (("skill_runs"."recovery_point" = 'finished') = ("skill_runs"."status" <> 'running'));--> statement-breakpoint
-- Runs that finished before 0042 added `resource_usage` carry none, and the
-- CHECK below requires it past `started`. Give them what the runner records:
-- the wall clock from the row's creation to the worker's return, and no peak
-- memory (what the WASM tier reports). Every other shape the CHECKs reject
-- has no writer in a shipped build and stops this file, which rolls back as
-- one transaction naming the constraint.
UPDATE "skill_runs"
SET "resource_usage" = jsonb_build_object(
  'wallClockMs', GREATEST(0, floor(EXTRACT(EPOCH FROM ("finished_at" - "created_at")) * 1000))::bigint,
  'peakMemoryBytes', NULL
)
WHERE "recovery_point" <> 'started' AND "resource_usage" IS NULL AND "finished_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "chk_skill_runs_executed_payload" CHECK (("skill_runs"."recovery_point" = 'started') = ("skill_runs"."finished_at" IS NULL) AND ("skill_runs"."recovery_point" = 'started') = ("skill_runs"."resource_usage" IS NULL) AND ("skill_runs"."recovery_point" <> 'started' OR ("skill_runs"."output" IS NULL AND "skill_runs"."error" IS NULL)));--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "chk_skill_runs_outcome" CHECK (NOT ("skill_runs"."output" IS NOT NULL AND "skill_runs"."error" IS NOT NULL) AND ("skill_runs"."status" <> 'success' OR "skill_runs"."error" IS NULL) AND ("skill_runs"."status" <> 'error' OR ("skill_runs"."error" IS NOT NULL AND "skill_runs"."output" IS NULL)));
