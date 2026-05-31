CREATE TYPE "public"."skill_deploy_status" AS ENUM('pending_approval', 'approved', 'denied', 'live', 'rolled_back');--> statement-breakpoint
CREATE TYPE "public"."skill_risk_tier" AS ENUM('auto', 'notify', 'approve');--> statement-breakpoint
CREATE TYPE "public"."skill_run_status" AS ENUM('running', 'success', 'error');--> statement-breakpoint
CREATE TYPE "public"."skill_run_trigger" AS ENUM('manual', 'cron', 'event');--> statement-breakpoint
CREATE TYPE "public"."skill_tier" AS ENUM('wasm', 'container');--> statement-breakpoint
CREATE TABLE "skill_context_calls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"run_id" uuid NOT NULL,
	"method" text NOT NULL,
	"target" text,
	"ok" boolean NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_deploys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"skill_id" uuid NOT NULL,
	"git_sha" text NOT NULL,
	"prior_git_sha" text,
	"risk_tier" "skill_risk_tier" NOT NULL,
	"status" "skill_deploy_status" NOT NULL,
	"approved_by" uuid,
	"classifier_log" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "skill_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"skill_id" uuid NOT NULL,
	"trigger" "skill_run_trigger" NOT NULL,
	"inputs" jsonb NOT NULL,
	"status" "skill_run_status" NOT NULL,
	"output" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"tier" "skill_tier" NOT NULL,
	"risk_tier" "skill_risk_tier" NOT NULL,
	"effects" jsonb NOT NULL,
	"schedule" text,
	"git_sha" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"outputs" jsonb,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "skill_context_calls" ADD CONSTRAINT "skill_context_calls_run_id_skill_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."skill_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_deploys" ADD CONSTRAINT "skill_deploys_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_deploys" ADD CONSTRAINT "skill_deploys_approved_by_user_identities_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_skill_context_calls_run_id" ON "skill_context_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_skill_deploys_skill_id" ON "skill_deploys" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "idx_skill_runs_skill_id" ON "skill_runs" USING btree ("skill_id");