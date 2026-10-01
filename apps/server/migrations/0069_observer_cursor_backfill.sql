-- Start each observed conversation's cursors at its last Observer fire: every
-- fire before the cursors read the whole transcript, so the messages created
-- at or before the latest audit row were extracted. A conversation without an
-- audit row keeps NULL and is read whole on its next fire.
WITH "last_fire" AS (
  SELECT "conversation_id", max("created_at") AS "fired_at"
  FROM "evolution_events"
  GROUP BY "conversation_id"
), "observed" AS (
  SELECT DISTINCT ON ("messages"."conversation_id")
    "messages"."conversation_id", "messages"."id"
  FROM "messages"
  JOIN "last_fire" ON "last_fire"."conversation_id" = "messages"."conversation_id"
  WHERE "messages"."created_at" <= "last_fire"."fired_at"
  ORDER BY "messages"."conversation_id", "messages"."id" DESC
)
UPDATE "conversations"
SET "corrections_observed_through" = "observed"."id",
  "memories_observed_through" = "observed"."id"
FROM "observed"
WHERE "conversations"."id" = "observed"."conversation_id"
  AND "conversations"."corrections_observed_through" IS NULL
  AND "conversations"."memories_observed_through" IS NULL;
