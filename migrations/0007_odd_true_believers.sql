-- Telegram session/profile/model management — schema + backfill.
--
-- Adds:
--   profiles.user_id            (nullable — NULL = org profile, read-only via Transport)
--   model_providers.user_selectable  (gates user-facing /model picker)
--   messages.profile_id         (NOT NULL — backfilled from conversations.profile_id)
--   messages.model              (NOT NULL — backfilled with '<legacy>' sentinel for pre-stamping rows)
--   aliases                     (new table — user-set conversation aliases)
--
-- SENTINEL: messages.model = '<legacy>' marks rows from before per-turn stamping landed.
-- Angle brackets disambiguate from real model IDs (no provider uses '<' in model strings).
-- Audit queries should filter `WHERE model <> '<legacy>'`.
--
-- Column additions are done in three phases (ADD nullable → backfill → SET NOT NULL)
-- so the migration succeeds on non-empty tables.

CREATE TABLE "aliases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aliases_conversation_id_unique" UNIQUE("conversation_id"),
	CONSTRAINT "uq_aliases_user_alias" UNIQUE("user_id","alias")
);
--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- profiles.user_id — nullable, existing rows become org profiles (NULL).
ALTER TABLE "profiles" DROP CONSTRAINT "uq_profiles_name";--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "uq_profiles_user_name" UNIQUE NULLS NOT DISTINCT("user_id","name");--> statement-breakpoint

-- model_providers.user_selectable — add nullable, backfill true, then NOT NULL.
ALTER TABLE "model_providers" ADD COLUMN "user_selectable" boolean;--> statement-breakpoint
UPDATE "model_providers" SET "user_selectable" = true WHERE "user_selectable" IS NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ALTER COLUMN "user_selectable" SET NOT NULL;--> statement-breakpoint

-- messages.profile_id + messages.model — add nullable, backfill, then NOT NULL + FK.
ALTER TABLE "messages" ADD COLUMN "profile_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "model" text;--> statement-breakpoint
UPDATE "messages" SET "profile_id" = (SELECT "profile_id" FROM "conversations" WHERE "conversations"."id" = "messages"."conversation_id") WHERE "profile_id" IS NULL;--> statement-breakpoint
UPDATE "messages" SET "model" = '<legacy>' WHERE "model" IS NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "profile_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "model" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;
