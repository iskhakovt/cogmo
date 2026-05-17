ALTER TABLE "inbound_messages" DROP CONSTRAINT "chk_inbound_source_session";--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "scheduled_fire_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inbound_scheduled_fire_key" ON "inbound_messages" USING btree ("scheduled_fire_key") WHERE scheduled_fire_key IS NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "chk_inbound_source_session" CHECK (("inbound_messages"."source" = 'user' AND "inbound_messages"."channel_session_id" IS NOT NULL AND "inbound_messages"."scheduled_fire_key" IS NULL)
        OR ("inbound_messages"."source" = 'scheduled' AND "inbound_messages"."channel_session_id" IS NULL AND "inbound_messages"."scheduled_fire_key" IS NOT NULL));