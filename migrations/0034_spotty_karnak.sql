CREATE TYPE "public"."channel_session_receive" AS ENUM('none', 'routed', 'all');--> statement-breakpoint
CREATE TYPE "public"."channel_session_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."inbound_message_source" AS ENUM('user', 'scheduled');--> statement-breakpoint
-- The partial index predicate `status = 'active' AND receive = 'all'`
-- references the columns by oid with text-typed literals. After ALTER
-- COLUMN promotes them to enums, those comparisons need explicit casts.
-- Easiest: drop the index, alter the columns, recreate it against the
-- enum types (the recreated predicate auto-resolves to enum=enum).
DROP INDEX IF EXISTS "idx_sessions_receive_all";--> statement-breakpoint
ALTER TABLE "channel_sessions" ALTER COLUMN "status" SET DATA TYPE "public"."channel_session_status" USING "status"::"public"."channel_session_status";--> statement-breakpoint
ALTER TABLE "channel_sessions" ALTER COLUMN "receive" SET DATA TYPE "public"."channel_session_receive" USING "receive"::"public"."channel_session_receive";--> statement-breakpoint
CREATE INDEX "idx_sessions_receive_all" ON "channel_sessions" USING btree ("conversation_id") WHERE status = 'active' AND receive = 'all';--> statement-breakpoint
ALTER TABLE "inbound_messages" ALTER COLUMN "channel_session_id" DROP NOT NULL;--> statement-breakpoint
-- Backfill `source` for every existing row before adding the NOT NULL.
-- All prior inbounds came from a real platform message, so they're all
-- 'user' by definition. Done as: add nullable → backfill → set NOT NULL.
ALTER TABLE "inbound_messages" ADD COLUMN "source" "inbound_message_source";--> statement-breakpoint
UPDATE "inbound_messages" SET "source" = 'user' WHERE "source" IS NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "chk_inbound_source_session" CHECK (("inbound_messages"."source" = 'user' AND "inbound_messages"."channel_session_id" IS NOT NULL)
        OR ("inbound_messages"."source" = 'scheduled' AND "inbound_messages"."channel_session_id" IS NULL));
