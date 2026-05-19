CREATE TABLE "boundary_pending" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"channel_id" uuid NOT NULL,
	"platform_address" text NOT NULL,
	"platform_user_handle" text NOT NULL,
	"prior_conversation_id" uuid NOT NULL,
	"prompt_message_id" text NOT NULL,
	"buffered_inbounds" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_boundary_pending_address" UNIQUE("channel_id","platform_address")
);
--> statement-breakpoint
ALTER TABLE "boundary_pending" ADD CONSTRAINT "boundary_pending_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boundary_pending" ADD CONSTRAINT "boundary_pending_prior_conversation_id_conversations_id_fk" FOREIGN KEY ("prior_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;