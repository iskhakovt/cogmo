CREATE TYPE "public"."coding_backend" AS ENUM('claude', 'codex');--> statement-breakpoint
CREATE TYPE "public"."coding_task_status" AS ENUM('queued', 'planning', 'awaiting_approval', 'executing', 'verifying', 'pushed', 'pr_open', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."coding_trigger_source" AS ENUM('user', 'evolution', 'signal_pipeline');--> statement-breakpoint
CREATE TABLE "coding_repos" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"local_path" text NOT NULL,
	"default_branch" text NOT NULL,
	"remote_url" text NOT NULL,
	"devcontainer" jsonb,
	"allowed_backends" "coding_backend"[] NOT NULL,
	"verify_command" text NOT NULL,
	"task_token_budget" integer NOT NULL,
	"task_wall_time_seconds" integer NOT NULL,
	"max_concurrent_tasks" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coding_repos_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "coding_tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"repo_id" uuid NOT NULL,
	"conversation_id" uuid,
	"goal" text NOT NULL,
	"trigger_source" "coding_trigger_source" NOT NULL,
	"trigger_ref" text,
	"backend" "coding_backend" NOT NULL,
	"worktree_assignment" jsonb,
	"session_id" text,
	"container_id" uuid,
	"allow_privileged_runc" boolean NOT NULL,
	"plan" text,
	"plan_approved_at" timestamp with time zone,
	"pr_url" text,
	"status" "coding_task_status" NOT NULL,
	"failure_reason" text,
	"resource_usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coding_tasks" ADD CONSTRAINT "coding_tasks_repo_id_coding_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."coding_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_tasks" ADD CONSTRAINT "coding_tasks_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE no action ON UPDATE no action;