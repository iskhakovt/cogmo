CREATE TABLE "turn_contexts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"message_id" uuid NOT NULL,
	"rendered" text NOT NULL,
	"context" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_turn_contexts_message" UNIQUE("message_id")
);
--> statement-breakpoint
ALTER TABLE "turn_contexts" ADD CONSTRAINT "turn_contexts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;