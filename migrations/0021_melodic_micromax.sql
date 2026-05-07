CREATE TYPE "public"."pending_memory_source" AS ENUM('live_retain', 'migration');--> statement-breakpoint
CREATE TYPE "public"."voice_mode" AS ENUM('auto', 'always', 'never');--> statement-breakpoint
CREATE TABLE "pending_memories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"content" text NOT NULL,
	"context" text,
	"source" "pending_memory_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_config" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tts_secret_id" uuid NOT NULL,
	"stt_secret_id" uuid NOT NULL,
	"tts_provider" text NOT NULL,
	"tts_model" text NOT NULL,
	"tts_voice" text NOT NULL,
	"tts_base_url" text,
	"stt_provider" text NOT NULL,
	"stt_model" text NOT NULL,
	"stt_base_url" text,
	"singleton" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_voice_config_singleton" UNIQUE("singleton"),
	CONSTRAINT "chk_voice_config_singleton" CHECK (singleton = true)
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "voice_mode" "voice_mode";--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "voice_mode" "voice_mode" DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "memory_scope" jsonb;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "voice_max_reply_chars" integer DEFAULT 700 NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_memories" ADD CONSTRAINT "pending_memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_config" ADD CONSTRAINT "voice_config_tts_secret_id_secrets_id_fk" FOREIGN KEY ("tts_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_config" ADD CONSTRAINT "voice_config_stt_secret_id_secrets_id_fk" FOREIGN KEY ("stt_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pending_memories_user" ON "pending_memories" USING btree ("user_id","created_at");