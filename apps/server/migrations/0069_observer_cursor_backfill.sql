-- Start each observed conversation's cursors at the last message its latest
-- fire read. Every fire before the cursors read the whole transcript, ordered
-- by id, and recorded how many messages that was (`messageCount`); messages
-- are deleted only with their conversation, so the read was the first
-- `messageCount` messages by id, and the last of them is the cursor.
--
-- Each phase starts at the latest fire that extracted it: one that didn't fail
-- it (`failedPhases`; a row without the field failed none) and, for memories,
-- didn't hold them for a user's rule the profile couldn't see
-- (`memories.skippedForUnseenRules` above 0; missing reads as 0). A skipped
-- fire writes no row. A row without `messageCount`, or counting more messages
-- than the conversation has, describes no read of this transcript and doesn't
-- qualify. A phase with no qualifying fire, like a conversation the Observer
-- never fired on, stays NULL and is read whole on its next fire.
WITH "fires" AS (
  SELECT "conversation_id",
    ("payload"->>'messageCount')::int AS "message_count",
    COALESCE("payload"->'failedPhases', '[]'::jsonb) AS "failed",
    COALESCE(("payload"->'memories'->>'skippedForUnseenRules')::int, 0) > 0 AS "memories_held"
  FROM "evolution_events"
  WHERE "payload"->>'messageCount' IS NOT NULL
    AND ("payload"->>'messageCount')::int <= (
      SELECT count(*) FROM "messages"
      WHERE "messages"."conversation_id" = "evolution_events"."conversation_id"
    )
), "read" AS (
  SELECT "conversation_id",
    max("message_count") FILTER (
      WHERE NOT "failed" @> '["corrections"]'::jsonb
    ) AS "corrections_count",
    max("message_count") FILTER (
      WHERE NOT "failed" @> '["memories"]'::jsonb AND NOT "memories_held"
    ) AS "memories_count"
  FROM "fires"
  GROUP BY "conversation_id"
), "numbered" AS (
  SELECT "messages"."conversation_id", "messages"."id",
    row_number() OVER (PARTITION BY "messages"."conversation_id" ORDER BY "messages"."id") AS "position"
  FROM "messages"
  JOIN "read" ON "read"."conversation_id" = "messages"."conversation_id"
)
UPDATE "conversations"
SET "corrections_observed_through" = (
    SELECT "numbered"."id" FROM "numbered"
    WHERE "numbered"."conversation_id" = "conversations"."id"
      AND "numbered"."position" = "read"."corrections_count"
  ),
  "memories_observed_through" = (
    SELECT "numbered"."id" FROM "numbered"
    WHERE "numbered"."conversation_id" = "conversations"."id"
      AND "numbered"."position" = "read"."memories_count"
  )
FROM "read"
WHERE "conversations"."id" = "read"."conversation_id"
  AND "conversations"."corrections_observed_through" IS NULL
  AND "conversations"."memories_observed_through" IS NULL;
