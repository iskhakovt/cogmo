CREATE TYPE "public"."observation_failure_kind" AS ENUM('context_overflow', 'refusal', 'output_cut_off', 'parse', 'rejected', 'exhausted');--> statement-breakpoint
CREATE TYPE "public"."observation_phase" AS ENUM('corrections');--> statement-breakpoint
CREATE TYPE "public"."observation_skip_reason" AS ENUM('not_user_speech', 'empty', 'backfilled', 'aged_out');--> statement-breakpoint
CREATE TYPE "public"."observation_status" AS ENUM('pending', 'applied', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."turn_kind" AS ENUM('chat', 'scheduled', 'pipeline');--> statement-breakpoint
CREATE TABLE "turn_observations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_cursor" uuid NOT NULL,
	"turn_kind" "turn_kind" NOT NULL,
	"phase" "observation_phase" NOT NULL,
	"status" "observation_status" NOT NULL,
	"skip_reason" "observation_skip_reason",
	"attempts" integer NOT NULL,
	"failure_kind" "observation_failure_kind",
	"failure_message" text,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_turn_observations_turn_phase" UNIQUE("conversation_id","turn_cursor","phase"),
	CONSTRAINT "chk_turn_observations_state" CHECK ((("turn_observations"."status" = 'skipped') = ("turn_observations"."skip_reason" IS NOT NULL))
        AND (("turn_observations"."attempts" > 0) = ("turn_observations"."failure_kind" IS NOT NULL))
        AND (("turn_observations"."failure_kind" IS NULL) = ("turn_observations"."failure_message" IS NULL))
        AND ("turn_observations"."status" <> 'failed' OR "turn_observations"."attempts" > 0)
        AND ("turn_observations"."skip_reason" <> 'not_user_speech' OR "turn_observations"."turn_kind" <> 'chat'))
);
--> statement-breakpoint
ALTER TABLE "steering_rules" DROP CONSTRAINT "chk_steering_rules_lifecycle";--> statement-breakpoint
ALTER TABLE "steering_rules" ADD COLUMN "contradicted_in_turn_id" uuid;--> statement-breakpoint
ALTER TABLE "turn_observations" ADD CONSTRAINT "turn_observations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_turn_observations_pending" ON "turn_observations" USING btree ("conversation_id","phase") WHERE status = 'pending';--> statement-breakpoint
ALTER TABLE "steering_rules" ADD CONSTRAINT "steering_rules_contradicted_in_turn_id_turn_observations_id_fk" FOREIGN KEY ("contradicted_in_turn_id") REFERENCES "public"."turn_observations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_steering_rules_contradicted_in_turn" ON "steering_rules" USING btree ("contradicted_in_turn_id") WHERE contradicted_in_turn_id IS NOT NULL;--> statement-breakpoint
-- Where each conversation's corrections cursor starts. The transcript-era
-- Observer read the whole transcript by id and recorded its length as
-- `messageCount`, so its latest fire whose correction extraction returned
-- covered exactly the first `messageCount` messages. A fire qualifies on
-- positive evidence: `failedPhases` present without `corrections`, or, on a
-- row written before `failedPhases` existed, a non-zero correction count; and
-- a `messageCount` no larger than the conversation's message count. An
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
    AND CASE
      WHEN e."payload"->'failedPhases' IS NOT NULL
        THEN NOT (e."payload"->'failedPhases' @> '["corrections"]'::jsonb)
      ELSE (e."payload"->'corrections'->>'extracted')::integer
        + (e."payload"->'corrections'->>'reinforced')::integer
        + (e."payload"->'corrections'->>'contradictions')::integer > 0
    END
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
  'corrections', 'skipped',
  CASE WHEN t."last_id" <= b."through_id" THEN 'backfilled' ELSE 'aged_out' END::"observation_skip_reason",
  0, now()
FROM "turns" t
LEFT JOIN "boundaries" b ON b."conversation_id" = t."conversation_id"
LEFT JOIN "inbound_messages" i ON i."id" = t."cursor"
WHERE t."last_id" <= b."through_id" OR t."last_at" < now() - interval '30 days';--> statement-breakpoint
-- A contradiction record named a conversation; the marker names a turn. Each
-- record moves to the newest `backfilled` turn of its conversation, which the
-- fire that wrote it had read. A conversation with none leaves the marker
-- NULL, so that rule's next contradiction resets it rather than retiring it.
UPDATE "steering_rules" r SET "contradicted_in_turn_id" = (
  SELECT o."id" FROM "turn_observations" o
  WHERE o."conversation_id" = r."contradicted_in_conversation_id"
    AND o."skip_reason" = 'backfilled'
  ORDER BY (
    SELECT max(m."id"::text COLLATE "C") FROM "messages" m
    WHERE m."conversation_id" = o."conversation_id" AND m."last_inbound_message_id" = o."turn_cursor"
  ) DESC
  LIMIT 1
)
WHERE r."contradicted_in_conversation_id" IS NOT NULL;--> statement-breakpoint
UPDATE "steering_rules" SET "contradicted_in_conversation_id" = NULL
WHERE "contradicted_in_conversation_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "steering_rules" ADD CONSTRAINT "chk_steering_rules_lifecycle" CHECK ((("steering_rules"."status" = 'retired') = ("steering_rules"."retracted_at" IS NOT NULL))
        AND (("steering_rules"."status" = 'retired') = ("steering_rules"."retired_reason" IS NOT NULL))
        AND ("steering_rules"."contradicted_in_conversation_id" IS NULL OR "steering_rules"."status" IN ('learning', 'retired'))
        AND ("steering_rules"."contradicted_in_turn_id" IS NULL OR "steering_rules"."status" IN ('learning', 'retired'))
        AND ("steering_rules"."status" <> 'learning' OR "steering_rules"."source" IN ('correction', 'evolution'))
        AND ("steering_rules"."status" <> 'disabled' OR "steering_rules"."source" IN ('manual', 'seed'))
        AND (("steering_rules"."source" = 'instruction') = ("steering_rules"."user_id" IS NOT NULL))
        AND (("steering_rules"."source" = 'instruction') = ("steering_rules"."quote" IS NOT NULL)));