ALTER TABLE "messages" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
-- Backfill with sentinel -1 ("unknown, pre-migration"). The fast path
-- (shouldSkipCounting) treats -1 as unknown and forces token counting,
-- keeping old conversations safe without corrupting budget math.
UPDATE "messages" SET "output_tokens" = -1 WHERE "output_tokens" IS NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "output_tokens" SET NOT NULL;
