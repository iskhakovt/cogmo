ALTER TABLE "skills" ADD COLUMN "run_as_user_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "run_as_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_run_as_user_id_users_id_fk" FOREIGN KEY ("run_as_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_run_as_profile_id_profiles_id_fk" FOREIGN KEY ("run_as_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A scheduled skill runs as the install owner (the oldest user) with the
-- default profile (the oldest profile), the identity a deploy without an
-- approver captures.
UPDATE "skills" SET
  "run_as_user_id" = (SELECT "id" FROM "users" ORDER BY "id" LIMIT 1),
  "run_as_profile_id" = (SELECT "id" FROM "profiles" ORDER BY "id" LIMIT 1)
WHERE "schedule" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "chk_skills_run_as_iff_schedule" CHECK (("skills"."schedule" IS NULL) = ("skills"."run_as_user_id" IS NULL) AND ("skills"."schedule" IS NULL) = ("skills"."run_as_profile_id" IS NULL));