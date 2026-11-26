ALTER TABLE "turn_observations" DROP CONSTRAINT "chk_turn_observations_state";--> statement-breakpoint
DROP INDEX "idx_turn_observations_pending";--> statement-breakpoint
ALTER TABLE "turn_observations" ADD COLUMN "extraction" jsonb;--> statement-breakpoint
CREATE INDEX "idx_turn_observations_open" ON "turn_observations" USING btree ("conversation_id","phase") WHERE status IN ('pending', 'held', 'held_extracted', 'extracted');--> statement-breakpoint
-- Where each conversation's memories cursor starts. The transcript-era
-- Observer read the whole transcript by id and recorded its length as
-- `messageCount`, so its latest fire whose memory extraction returned covered
-- exactly the first `messageCount` messages. Only a positive
-- `memories.extracted` proves the call returned: the transcript phase recorded
-- 0 for a failure, a held phase and an empty extraction alike. A fire also
-- needs a `messageCount` no larger than the conversation's message count. An
-- answered turn whose rows all fall at or below that boundary is `skipped`
-- (`backfilled`); any other answered turn whose newest row is over 30 days old
-- is `skipped` (`aged_out`). Every other turn gets no row, and the next fire
-- discovers it as `pending`.
WITH "qualifying" AS (
  SELECT e."conversation_id", max((e."payload"->>'messageCount')::integer) AS "message_count"
  FROM "evolution_events" e
  WHERE e."payload"->'messageCount' IS NOT NULL
    AND (e."payload"->>'messageCount')::integer
      <= (SELECT count(*) FROM "messages" m WHERE m."conversation_id" = e."conversation_id")
    AND (e."payload"->'memories'->>'extracted')::integer > 0
  GROUP BY e."conversation_id"
),
"boundaries" AS (
  SELECT q."conversation_id",
    (SELECT m."id" FROM "messages" m
      WHERE m."conversation_id" = q."conversation_id"
      ORDER BY m."id" OFFSET q."message_count" - 1 LIMIT 1) AS "through_id"
  FROM "qualifying" q
  WHERE q."message_count" > 0
),
"turns" AS (
  SELECT m."conversation_id", m."last_inbound_message_id" AS "cursor",
    max(m."id"::text COLLATE "C")::uuid AS "last_id", max(m."created_at") AS "last_at"
  FROM "messages" m
  GROUP BY m."conversation_id", m."last_inbound_message_id"
  HAVING bool_or(m."role" = 'assistant')
)
INSERT INTO "turn_observations"
  ("conversation_id", "turn_cursor", "turn_kind", "phase", "status", "skip_reason", "attempts", "updated_at")
SELECT t."conversation_id", t."cursor",
  CASE i."source" WHEN 'scheduled' THEN 'scheduled' WHEN 'pipeline' THEN 'pipeline' ELSE 'chat' END::"turn_kind",
  'memories', 'skipped',
  CASE WHEN t."last_id" <= b."through_id" THEN 'backfilled' ELSE 'aged_out' END::"observation_skip_reason",
  0, now()
FROM "turns" t
LEFT JOIN "boundaries" b ON b."conversation_id" = t."conversation_id"
LEFT JOIN "inbound_messages" i ON i."id" = t."cursor"
WHERE t."last_id" <= b."through_id" OR t."last_at" < now() - interval '30 days';--> statement-breakpoint
ALTER TABLE "turn_observations" ADD CONSTRAINT "chk_turn_observations_state" CHECK ((("turn_observations"."status" = 'skipped') = ("turn_observations"."skip_reason" IS NOT NULL))
        AND (("turn_observations"."attempts" > 0) = ("turn_observations"."failure_kind" IS NOT NULL))
        AND (("turn_observations"."failure_kind" IS NULL) = ("turn_observations"."failure_message" IS NULL))
        AND ("turn_observations"."status" <> 'failed' OR "turn_observations"."attempts" > 0)
        AND ("turn_observations"."skip_reason" <> 'not_user_speech' OR ("turn_observations"."phase" = 'corrections' AND "turn_observations"."turn_kind" <> 'chat'))
        AND ("turn_observations"."status" NOT IN ('held', 'held_extracted', 'extracted') OR "turn_observations"."phase" = 'memories')
        AND ("turn_observations"."extraction" IS NULL OR "turn_observations"."phase" = 'memories')
        AND ("turn_observations"."status" NOT IN ('pending', 'held', 'skipped') OR "turn_observations"."extraction" IS NULL)
        AND ("turn_observations"."phase" <> 'memories' OR "turn_observations"."status" NOT IN ('held_extracted', 'extracted', 'applied') OR "turn_observations"."extraction" IS NOT NULL));