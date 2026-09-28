CREATE TABLE "system_prompt_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"opened_by" uuid NOT NULL,
	"history_start" uuid NOT NULL,
	"rendered" text NOT NULL,
	"config_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_system_prompt_snapshots_conv_opened_by" UNIQUE("conversation_id","opened_by")
);
--> statement-breakpoint
ALTER TABLE "system_prompt_snapshots" ADD CONSTRAINT "system_prompt_snapshots_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_prompt_snapshots" ADD CONSTRAINT "system_prompt_snapshots_opened_by_messages_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_prompt_snapshots" ADD CONSTRAINT "system_prompt_snapshots_history_start_messages_id_fk" FOREIGN KEY ("history_start") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;