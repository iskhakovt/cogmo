CREATE TYPE "public"."conversation_status" AS ENUM('active', 'errored');--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "status" "conversation_status" DEFAULT 'active' NOT NULL;