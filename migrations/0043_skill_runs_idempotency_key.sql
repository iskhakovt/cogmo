CREATE TYPE "public"."skill_run_recovery_point" AS ENUM('started', 'executed', 'finished');--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "recovery_point" "skill_run_recovery_point" DEFAULT 'started' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "uniq_skill_runs_idempotency_key" UNIQUE("idempotency_key");