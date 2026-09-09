CREATE TYPE "public"."summary_source" AS ENUM('turn', 'manual');--> statement-breakpoint
CREATE TABLE "conversation_summaries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"through_message_id" uuid NOT NULL,
	"messages_summarized" integer NOT NULL,
	"model" text NOT NULL,
	"source" "summary_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_conversation_summaries_conv_through" UNIQUE("conversation_id","through_message_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_through_message_id_messages_id_fk" FOREIGN KEY ("through_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;