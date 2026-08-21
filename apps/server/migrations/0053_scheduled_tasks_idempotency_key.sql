ALTER TABLE "scheduled_tasks" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "uniq_scheduled_tasks_idempotency_key" UNIQUE("idempotency_key");