CREATE TYPE "public"."skill_run_recovery_point" AS ENUM('started', 'executed', 'finished');--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "recovery_point" "skill_run_recovery_point" DEFAULT 'started' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_skill_runs_idempotency_key" ON "skill_runs" USING btree ("idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
-- Backfill existing terminal rows to `recovery_point='finished'`. The ADD
-- COLUMN default ('started') is what new inserts want; existing rows were
-- terminal pre-migration (status set, finished_at set) so 'finished' is
-- the right value for them. Idempotent: the WHERE clause excludes the
-- rare in-flight row (finished_at IS NULL — should be zero at migration
-- time but the guard keeps the statement safe to re-run).
UPDATE "skill_runs"
SET "recovery_point" = 'finished'
WHERE "finished_at" IS NOT NULL AND "recovery_point" = 'started';