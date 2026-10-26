CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."channel_identity_mode" AS ENUM('fixed', 'mapped', 'create');--> statement-breakpoint
DROP INDEX "uq_channels_fixed_type";--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "role" SET DATA TYPE "public"."message_role" USING "role"::"public"."message_role";--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "identity_mode" SET DATA TYPE "public"."channel_identity_mode" USING "identity_mode"::"public"."channel_identity_mode";