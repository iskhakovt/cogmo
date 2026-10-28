CREATE TYPE "public"."container_reaped_reason" AS ENUM('ttl_expired', 'cascade', 'dead_instance', 'crash_reconcile', 'start_failed', 'unknown');--> statement-breakpoint
ALTER TABLE "containers" ADD COLUMN "reaped_reason" "container_reaped_reason";--> statement-breakpoint
-- Rows reaped before the column existed record no reason; the CHECK below
-- requires one, so they get the value no code path writes.
UPDATE "containers" SET "reaped_reason" = 'unknown' WHERE "status" = 'reaped' AND "reaped_reason" IS NULL;--> statement-breakpoint
ALTER TABLE "containers" DROP COLUMN "exit_code";--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "chk_containers_reaped_reason" CHECK (("containers"."status" = 'reaped') = ("containers"."reaped_reason" IS NOT NULL));