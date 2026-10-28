CREATE TYPE "public"."steering_rule_status" AS ENUM('live', 'learning', 'disabled', 'retired');--> statement-breakpoint
ALTER TABLE "steering_rules" DROP CONSTRAINT "chk_steering_rules_lifecycle";--> statement-breakpoint
DROP INDEX "uq_steering_rules_instruction";--> statement-breakpoint
ALTER TABLE "steering_rules" ADD COLUMN "status" "steering_rule_status";--> statement-breakpoint
-- Backfill `status` from the lifecycle `active` and `retracted_at` encode by
-- source: a row with `retracted_at` is retired; an active one is live; an
-- inactive, unretired learned rule (`correction`, `evolution`) is learning; an
-- inactive, unretired operator rule or channel default (`manual`, `seed`) is
-- one an operator switched off. The CHECK below rejects any other row, which
-- rolls the file back.
UPDATE "steering_rules" SET "status" = CASE
  WHEN "retracted_at" IS NOT NULL THEN 'retired'
  WHEN "active" THEN 'live'
  WHEN "source" IN ('correction', 'evolution') THEN 'learning'
  ELSE 'disabled'
END::"steering_rule_status";--> statement-breakpoint
ALTER TABLE "steering_rules" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_steering_rules_instruction" ON "steering_rules" USING btree (lower(btrim(regexp_replace(rule, '[[:space:]]+', ' ', 'g'))),user_id,COALESCE(profile_id, '00000000-0000-0000-0000-000000000000'::uuid),COALESCE(channel_type, '')) WHERE source = 'instruction' AND status = 'live';--> statement-breakpoint
ALTER TABLE "steering_rules" DROP COLUMN "active";--> statement-breakpoint
ALTER TABLE "steering_rules" ADD CONSTRAINT "chk_steering_rules_lifecycle" CHECK ((("steering_rules"."status" = 'retired') = ("steering_rules"."retracted_at" IS NOT NULL))
        AND ("steering_rules"."status" <> 'learning' OR "steering_rules"."source" IN ('correction', 'evolution'))
        AND ("steering_rules"."status" <> 'disabled' OR "steering_rules"."source" IN ('manual', 'seed'))
        AND (("steering_rules"."source" = 'instruction') = ("steering_rules"."user_id" IS NOT NULL))
        AND (("steering_rules"."source" = 'instruction') = ("steering_rules"."quote" IS NOT NULL)));
