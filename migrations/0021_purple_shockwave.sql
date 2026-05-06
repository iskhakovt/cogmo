CREATE TYPE "public"."pending_memory_source" AS ENUM('live_retain', 'migration');--> statement-breakpoint
CREATE TABLE "pending_memories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"content" text NOT NULL,
	"context" text,
	"source" "pending_memory_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_memories" ADD CONSTRAINT "pending_memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pending_memories_user" ON "pending_memories" USING btree ("user_id","created_at");