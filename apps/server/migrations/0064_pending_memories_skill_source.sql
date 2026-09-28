-- `chk_pending_memories_skill_name` names 'skill', so it lives in 0065: Postgres
-- rejects a new enum value's use in the transaction that added it, and
-- `migratePerFile` commits each file separately.

ALTER TYPE "public"."pending_memory_source" ADD VALUE 'skill';--> statement-breakpoint
ALTER TABLE "pending_memories" ADD COLUMN "skill_name" text;