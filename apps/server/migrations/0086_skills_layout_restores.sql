CREATE TABLE "skills_repo_layout" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"singleton" boolean NOT NULL,
	"layout_commit_sha" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_repo_layout_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "chk_skills_repo_layout_singleton" CHECK ("skills_repo_layout"."singleton")
);
--> statement-breakpoint
ALTER TABLE "skill_deploys" ADD COLUMN "restores_git_sha" text;--> statement-breakpoint
-- A rollback before the column rewound main to its target, so the row's own
-- sha is the commit it restored.
UPDATE "skill_deploys" SET "restores_git_sha" = "git_sha" WHERE "status" = 'rolled_back';--> statement-breakpoint
ALTER TABLE "skill_deploys" ADD CONSTRAINT "chk_skill_deploys_restores_iff_rolled_back" CHECK (("skill_deploys"."status" = 'rolled_back') = ("skill_deploys"."restores_git_sha" IS NOT NULL));