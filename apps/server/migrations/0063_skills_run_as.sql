ALTER TABLE "skills" ADD COLUMN "run_as_user_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "run_as_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_run_as_user_id_users_id_fk" FOREIGN KEY ("run_as_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_run_as_profile_id_profiles_id_fk" FOREIGN KEY ("run_as_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A live scheduled skill runs as the install owner (the oldest user) with the
-- default profile (the oldest profile): no existing deploy recorded where it
-- came from.
UPDATE "skills" SET
  "run_as_user_id" = (SELECT "id" FROM "users" ORDER BY "id" LIMIT 1),
  "run_as_profile_id" = (SELECT "id" FROM "profiles" ORDER BY "id" LIMIT 1)
WHERE "schedule" IS NOT NULL AND NOT "disabled";--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "chk_skills_run_as_iff_live_schedule" CHECK (("skills"."schedule" IS NOT NULL AND NOT "skills"."disabled") = ("skills"."run_as_user_id" IS NOT NULL) AND ("skills"."schedule" IS NOT NULL AND NOT "skills"."disabled") = ("skills"."run_as_profile_id" IS NOT NULL));