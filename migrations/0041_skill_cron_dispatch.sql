ALTER TABLE "skills" ADD COLUMN "next_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "last_fired_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_skills_due" ON "skills" USING btree ("next_run_at") WHERE schedule IS NOT NULL AND disabled = false;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "chk_skills_next_run_at_iff_schedule" CHECK (("skills"."schedule" IS NULL) = ("skills"."next_run_at" IS NULL));