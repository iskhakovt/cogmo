CREATE TYPE "public"."pipeline_run_status" AS ENUM('queued', 'running', 'waiting_gate', 'waiting_event', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"definition_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"status" "pipeline_run_status" NOT NULL,
	"current_stage" text NOT NULL,
	"iteration" integer NOT NULL,
	"stage_outputs" jsonb NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_definition_id_pipeline_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."pipeline_definitions"("id") ON DELETE no action ON UPDATE no action;