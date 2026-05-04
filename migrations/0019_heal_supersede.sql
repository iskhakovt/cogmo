CREATE TYPE "public"."conversation_status" AS ENUM('active', 'errored');--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "status" "conversation_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "superseded_by" uuid;