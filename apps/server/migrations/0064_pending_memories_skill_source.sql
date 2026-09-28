-- `chk_pending_memories_skill_name` names 'skill', so it is in the next
-- migration (`pending_memories_skill_name_check`): Postgres refuses a new enum
-- value's use in the transaction that added it, and the per-file migrator
-- (`src/db/migrate-per-file.ts`) commits this file first.

ALTER TYPE "public"."pending_memory_source" ADD VALUE 'skill';--> statement-breakpoint
ALTER TABLE "pending_memories" ADD COLUMN "skill_name" text;