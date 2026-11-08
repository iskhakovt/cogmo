CREATE TYPE "public"."system_prompt_epoch_reason" AS ENUM('first_turn', 'configuration', 'summary', 'compaction', 'attachments', 'prefix_violation');--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "transcript_head" jsonb;--> statement-breakpoint
ALTER TABLE "system_prompt_snapshots" ADD COLUMN "reason" "system_prompt_epoch_reason";--> statement-breakpoint
-- Each existing epoch gets the first reason the epoch rule records that its
-- columns show against the conversation's previous snapshot by `opened_by`:
-- none is the first turn; then a different configuration digest, a different
-- history start (a summary), a different attachment cutoff; anything else is
-- `configuration`. `compaction` leaves nothing in these columns, so no
-- existing row gets it.
UPDATE "system_prompt_snapshots" AS "s" SET "reason" = (CASE
  WHEN "p"."prev_id" IS NULL THEN 'first_turn'
  WHEN "s"."config_digest" <> "p"."prev_config_digest" THEN 'configuration'
  WHEN "s"."history_start" <> "p"."prev_history_start" THEN 'summary'
  WHEN "s"."attachment_cutoff" IS DISTINCT FROM "p"."prev_attachment_cutoff" THEN 'attachments'
  ELSE 'configuration'
END)::"system_prompt_epoch_reason"
FROM (
  SELECT "id",
    LAG("id") OVER "w" AS "prev_id",
    LAG("config_digest") OVER "w" AS "prev_config_digest",
    LAG("history_start") OVER "w" AS "prev_history_start",
    LAG("attachment_cutoff") OVER "w" AS "prev_attachment_cutoff"
  FROM "system_prompt_snapshots"
  WINDOW "w" AS (PARTITION BY "conversation_id" ORDER BY "opened_by")
) AS "p"
WHERE "s"."id" = "p"."id";--> statement-breakpoint
ALTER TABLE "system_prompt_snapshots" ALTER COLUMN "reason" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "chk_messages_transcript_head_assistant" CHECK ("messages"."transcript_head" IS NULL OR "messages"."role" = 'assistant');
