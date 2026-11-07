CREATE TYPE "public"."skill_run_error_kind" AS ENUM('skill_raised', 'output_invalid', 'load_failed', 'wall_clock_exceeded', 'memory_exceeded', 'skill_failed', 'input_invalid', 'skill_retryable', 'runtime_unavailable', 'dependency_unavailable', 'egress_unavailable', 'credential_unavailable', 'host_lost', 'result_lost', 'unknown');--> statement-breakpoint
ALTER TYPE "public"."skill_run_recovery_point" ADD VALUE 'dispatched' BEFORE 'executed';--> statement-breakpoint
ALTER TABLE "skill_runs" DROP CONSTRAINT "chk_skill_runs_executed_payload";--> statement-breakpoint
ALTER TABLE "skill_runs" DROP CONSTRAINT "chk_skill_runs_outcome";--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "error_kind" "skill_run_error_kind";--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "git_sha" text;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "run_as_user_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "run_as_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "shadow" boolean;--> statement-breakpoint
-- Every run so far ran live. Every insert writes `shadow` from here on, so
-- the column takes no default.
UPDATE "skill_runs" SET "shadow" = false;--> statement-breakpoint
ALTER TABLE "skill_runs" ALTER COLUMN "shadow" SET NOT NULL;--> statement-breakpoint
-- An error recorded before the column has no kind a writer named, so it gets
-- the one no code path writes. That covers an `executed` row still carrying
-- a worker's error as well as a finished `error` verdict.
UPDATE "skill_runs" SET "error_kind" = 'unknown' WHERE "error" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_run_as_user_id_users_id_fk" FOREIGN KEY ("run_as_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_run_as_profile_id_profiles_id_fk" FOREIGN KEY ("run_as_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_skill_runs_running" ON "skill_runs" USING btree ("created_at") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "idx_skill_runs_run_as_profile_id" ON "skill_runs" USING btree ("run_as_profile_id");--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "chk_skill_runs_error_kind_with_error" CHECK (("skill_runs"."error_kind" IS NULL) = ("skill_runs"."error" IS NULL));--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "chk_skill_runs_deadline_at" CHECK (("skill_runs"."recovery_point" <> 'started' OR "skill_runs"."deadline_at" IS NULL) AND ("skill_runs"."recovery_point" IN ('started', 'executed', 'finished') OR "skill_runs"."deadline_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "chk_skill_runs_audit_together" CHECK (("skill_runs"."git_sha" IS NULL) = ("skill_runs"."run_as_user_id" IS NULL) AND ("skill_runs"."git_sha" IS NULL) = ("skill_runs"."run_as_profile_id" IS NULL));--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "chk_skill_runs_executed_payload" CHECK (("skill_runs"."recovery_point" IN ('executed', 'finished')) = ("skill_runs"."finished_at" IS NOT NULL) AND ("skill_runs"."recovery_point" IN ('executed', 'finished')) = ("skill_runs"."resource_usage" IS NOT NULL) AND ("skill_runs"."recovery_point" IN ('executed', 'finished') OR ("skill_runs"."output" IS NULL AND "skill_runs"."error" IS NULL)));--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "chk_skill_runs_outcome" CHECK (("skill_runs"."output" IS NULL OR "skill_runs"."error" IS NULL OR ("skill_runs"."status" = 'error' AND "skill_runs"."error_kind" = 'output_invalid')) AND ("skill_runs"."status" <> 'success' OR "skill_runs"."error" IS NULL) AND ("skill_runs"."status" <> 'error' OR "skill_runs"."error" IS NOT NULL));