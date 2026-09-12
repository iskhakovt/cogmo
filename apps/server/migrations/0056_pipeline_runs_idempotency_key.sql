ALTER TABLE "pipeline_runs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "uniq_pipeline_runs_idempotency_key" UNIQUE("idempotency_key");