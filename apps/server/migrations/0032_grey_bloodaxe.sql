CREATE TYPE "public"."stt_provider_type" AS ENUM('openai', 'openai_compatible');--> statement-breakpoint
CREATE TYPE "public"."tts_provider_type" AS ENUM('openai', 'openai_compatible', 'elevenlabs');--> statement-breakpoint
ALTER TABLE "voice_config" ALTER COLUMN "tts_provider" SET DATA TYPE "public"."tts_provider_type" USING "tts_provider"::"public"."tts_provider_type";--> statement-breakpoint
ALTER TABLE "voice_config" ALTER COLUMN "stt_provider" SET DATA TYPE "public"."stt_provider_type" USING "stt_provider"::"public"."stt_provider_type";