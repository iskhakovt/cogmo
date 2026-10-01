-- Start each observed conversation's cursors where its last fire began
-- reading: every fire before the cursors read the whole transcript from a
-- history load at its start, so the messages created before that start were
-- extracted. A fire's start is its audit row's time less its `durationMs`; a
-- row without one is taken to have begun 10 minutes earlier, past the longest
-- fire's model calls and step retries, so a message is re-extracted rather
-- than skipped. Each phase starts at the latest fire that extracted it: one
-- that didn't fail it (`failedPhases`; a row without the field failed none),
-- didn't find the model too small for a chunk (`modelBudgetTooSmall`) and,
-- for memories, didn't hold them for a user's rule the profile couldn't see
-- (`memories.skippedForUnseenRules` above 0; missing reads as 0). A skipped
-- fire writes no row. A phase with no such fire, like a conversation the
-- Observer never fired on, stays NULL.
WITH "fires" AS (
  SELECT "conversation_id",
    "created_at" - COALESCE(
      ("payload"->>'durationMs')::bigint * interval '1 millisecond',
      interval '10 minutes'
    ) AS "started_at",
    COALESCE("payload"->'failedPhases', '[]'::jsonb) AS "failed",
    COALESCE(("payload"->'memories'->>'skippedForUnseenRules')::int, 0) > 0 AS "memories_held",
    COALESCE(("payload"->>'modelBudgetTooSmall')::boolean, false) AS "too_small"
  FROM "evolution_events"
), "last_start" AS (
  SELECT "conversation_id",
    max("started_at") FILTER (
      WHERE NOT "failed" @> '["corrections"]'::jsonb AND NOT "too_small"
    ) AS "corrections_at",
    max("started_at") FILTER (
      WHERE NOT "failed" @> '["memories"]'::jsonb AND NOT "memories_held" AND NOT "too_small"
    ) AS "memories_at"
  FROM "fires"
  GROUP BY "conversation_id"
)
UPDATE "conversations"
SET "corrections_observed_through" = (
    SELECT "messages"."id" FROM "messages"
    WHERE "messages"."conversation_id" = "conversations"."id"
      AND "messages"."created_at" <= "last_start"."corrections_at"
    ORDER BY "messages"."id" DESC
    LIMIT 1
  ),
  "memories_observed_through" = (
    SELECT "messages"."id" FROM "messages"
    WHERE "messages"."conversation_id" = "conversations"."id"
      AND "messages"."created_at" <= "last_start"."memories_at"
    ORDER BY "messages"."id" DESC
    LIMIT 1
  )
FROM "last_start"
WHERE "conversations"."id" = "last_start"."conversation_id"
  AND "conversations"."corrections_observed_through" IS NULL
  AND "conversations"."memories_observed_through" IS NULL;
