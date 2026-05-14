CREATE TYPE "public"."schedule_kind" AS ENUM('recurring', 'one_off');--> statement-breakpoint
CREATE TYPE "public"."schedule_source" AS ENUM('agent', 'wizard', 'manual');--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"kind" "schedule_kind" NOT NULL,
	"cron" text,
	"timezone" text NOT NULL,
	"prompt" text NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"enabled" boolean NOT NULL,
	"catchup_missed" boolean NOT NULL,
	"source" "schedule_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_scheduled_tasks_cron" CHECK (("scheduled_tasks"."kind" <> 'recurring' OR "scheduled_tasks"."cron" IS NOT NULL) AND ("scheduled_tasks"."kind" <> 'one_off' OR "scheduled_tasks"."cron" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_scheduled_tasks_due" ON "scheduled_tasks" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "idx_scheduled_tasks_user" ON "scheduled_tasks" USING btree ("user_id","created_at");