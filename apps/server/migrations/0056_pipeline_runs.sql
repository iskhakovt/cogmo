ALTER TYPE "public"."inbound_message_source" ADD VALUE 'pipeline';--> statement-breakpoint
ALTER TABLE "inbound_messages" RENAME COLUMN "scheduled_fire_key" TO "idempotency_key";--> statement-breakpoint
ALTER TABLE "inbound_messages" DROP CONSTRAINT "chk_inbound_source_session";--> statement-breakpoint
DROP INDEX "uq_inbound_scheduled_fire_key";--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inbound_idempotency_key" ON "inbound_messages" USING btree ("idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "uniq_pipeline_runs_idempotency_key" UNIQUE("idempotency_key");--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "chk_inbound_source_session" CHECK (("inbound_messages"."source" = 'user' AND "inbound_messages"."channel_session_id" IS NOT NULL AND "inbound_messages"."idempotency_key" IS NULL)
        OR ("inbound_messages"."source" <> 'user' AND "inbound_messages"."channel_session_id" IS NULL AND "inbound_messages"."idempotency_key" IS NOT NULL));