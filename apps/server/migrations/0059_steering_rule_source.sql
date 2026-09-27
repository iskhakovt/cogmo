CREATE TYPE "public"."steering_rule_source" AS ENUM('manual', 'seed', 'instruction', 'correction', 'evolution');--> statement-breakpoint
-- The channel defaults `seedChannelRules` wrote as `manual`: its three
-- Telegram texts, with every other column as it wrote them but `active`,
-- which an operator may have switched off.
UPDATE "steering_rules" SET "source" = 'seed'
WHERE "source" = 'manual'
  AND "channel_type" = 'telegram'
  AND "profile_id" IS NULL
  AND "priority" = 50
  AND "category" = 'style'
  AND "observation_count" = 0
  AND "rule" IN (
    'Avoid tables — they don''t render on this channel. Use bullet lists instead.',
    'Prefer concise replies. For longer answers, use headings and short paragraphs.',
    'Keep bullet lists to one level of nesting.'
  );--> statement-breakpoint
ALTER TABLE "steering_rules" ALTER COLUMN "source" SET DATA TYPE "public"."steering_rule_source" USING "source"::"public"."steering_rule_source";
