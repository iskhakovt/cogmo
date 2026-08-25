ALTER TABLE "coding_tasks" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "coding_tasks" ADD CONSTRAINT "uniq_coding_tasks_idempotency_key" UNIQUE("idempotency_key");