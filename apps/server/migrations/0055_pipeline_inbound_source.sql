ALTER TYPE "public"."inbound_message_source" ADD VALUE 'pipeline';--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "pipeline_stage_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pipeline_runs_active_conversation" ON "pipeline_runs" USING btree ("conversation_id") WHERE status NOT IN ('completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inbound_pipeline_stage_key" ON "inbound_messages" USING btree ("pipeline_stage_key") WHERE pipeline_stage_key IS NOT NULL;