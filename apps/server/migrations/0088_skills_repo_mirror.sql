CREATE TYPE "public"."skills_mirror_failure" AS ENUM('rejected', 'unreachable', 'auth', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."skills_mirror_status" AS ENUM('synced', 'behind', 'diverged');--> statement-breakpoint
CREATE TABLE "skills_repo_mirror" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"singleton" boolean NOT NULL,
	"status" "skills_mirror_status" NOT NULL,
	"local_sha" text,
	"pushed_sha" text,
	"last_failure" "skills_mirror_failure",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_repo_mirror_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "chk_skills_repo_mirror_singleton" CHECK ("skills_repo_mirror"."singleton"),
	CONSTRAINT "chk_skills_repo_mirror_synced_no_failure" CHECK ("skills_repo_mirror"."status" <> 'synced' OR "skills_repo_mirror"."last_failure" IS NULL),
	CONSTRAINT "chk_skills_repo_mirror_diverged_rejected" CHECK ("skills_repo_mirror"."status" <> 'diverged' OR "skills_repo_mirror"."last_failure" = 'rejected')
);
