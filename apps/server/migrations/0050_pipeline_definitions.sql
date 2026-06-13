CREATE TABLE "pipeline_definitions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"source_text" text NOT NULL,
	"compiled" jsonb NOT NULL,
	"active" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_definitions" ADD CONSTRAINT "pipeline_definitions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pipeline_definitions_version" ON "pipeline_definitions" USING btree ("user_id","name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pipeline_definitions_active" ON "pipeline_definitions" USING btree ("user_id","name") WHERE active = true;