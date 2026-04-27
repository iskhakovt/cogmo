CREATE TYPE "public"."decision_scope" AS ENUM('once', 'task');--> statement-breakpoint
CREATE TYPE "public"."tool_decision" AS ENUM('allow', 'deny');--> statement-breakpoint
CREATE TYPE "public"."network_status" AS ENUM('created', 'reaped');--> statement-breakpoint
CREATE TYPE "public"."volume_status" AS ENUM('created', 'reaped');--> statement-breakpoint
CREATE TABLE "coding_tool_decisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"task_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"pattern" text NOT NULL,
	"decision" "tool_decision" NOT NULL,
	"scope" "decision_scope" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"docker_id" text NOT NULL,
	"parent_id" uuid,
	"root_task_id" uuid NOT NULL,
	"depth" integer NOT NULL,
	"labels" jsonb NOT NULL,
	"status" "network_status" NOT NULL,
	"ttl_expires_at" timestamp with time zone NOT NULL,
	"instance_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "networks_docker_id_unique" UNIQUE("docker_id")
);
--> statement-breakpoint
CREATE TABLE "volumes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"docker_id" text NOT NULL,
	"parent_id" uuid,
	"root_task_id" uuid NOT NULL,
	"depth" integer NOT NULL,
	"labels" jsonb NOT NULL,
	"status" "volume_status" NOT NULL,
	"ttl_expires_at" timestamp with time zone NOT NULL,
	"instance_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "volumes_docker_id_unique" UNIQUE("docker_id")
);
--> statement-breakpoint
ALTER TABLE "coding_tool_decisions" ADD CONSTRAINT "coding_tool_decisions_task_id_coding_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."coding_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networks" ADD CONSTRAINT "networks_parent_id_containers_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."containers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networks" ADD CONSTRAINT "networks_instance_id_cogmo_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."cogmo_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volumes" ADD CONSTRAINT "volumes_parent_id_containers_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."containers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volumes" ADD CONSTRAINT "volumes_instance_id_cogmo_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."cogmo_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_coding_tool_decisions_task_id" ON "coding_tool_decisions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_networks_instance_id" ON "networks" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "idx_networks_root_task_id" ON "networks" USING btree ("root_task_id");--> statement-breakpoint
CREATE INDEX "idx_networks_status_ttl" ON "networks" USING btree ("status","ttl_expires_at");--> statement-breakpoint
CREATE INDEX "idx_volumes_instance_id" ON "volumes" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "idx_volumes_root_task_id" ON "volumes" USING btree ("root_task_id");--> statement-breakpoint
CREATE INDEX "idx_volumes_status_ttl" ON "volumes" USING btree ("status","ttl_expires_at");