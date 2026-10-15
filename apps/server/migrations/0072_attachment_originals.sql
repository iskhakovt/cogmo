CREATE TYPE "public"."attachment_original_state" AS ENUM('decoding', 'ready', 'rejected');--> statement-breakpoint
CREATE TABLE "attachment_originals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"original_path" text NOT NULL,
	"state" "attachment_original_state" NOT NULL,
	"result" jsonb,
	"decode_attempts" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_attachment_originals_path" UNIQUE("original_path"),
	CONSTRAINT "chk_attachment_originals_decoding_result" CHECK ("attachment_originals"."state" <> 'decoding' OR "attachment_originals"."result" IS NULL),
	CONSTRAINT "chk_attachment_originals_ready_result" CHECK ("attachment_originals"."state" <> 'ready' OR "attachment_originals"."result" IS NOT NULL),
	CONSTRAINT "chk_attachment_originals_rejected_result" CHECK ("attachment_originals"."state" <> 'rejected' OR "attachment_originals"."result" IS NULL)
);
