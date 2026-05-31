ALTER TABLE "profiles" ADD COLUMN "stream_chunk_chars" integer DEFAULT 4000 NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "stream_edits" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "chk_profiles_stream_chunk_chars" CHECK ("profiles"."stream_chunk_chars" >= 100 AND "profiles"."stream_chunk_chars" <= 4000);