CREATE TYPE "public"."container_runtime" AS ENUM('sysbox-runc', 'runc');--> statement-breakpoint
CREATE TYPE "public"."container_status" AS ENUM('starting', 'running', 'exited', 'reaped');--> statement-breakpoint
CREATE TABLE "cogmo_instances" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"host" text NOT NULL,
	"pid" integer NOT NULL,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "containers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"docker_id" text NOT NULL,
	"parent_id" uuid,
	"root_task_id" uuid NOT NULL,
	"depth" integer NOT NULL,
	"image" text NOT NULL,
	"runtime" "container_runtime" NOT NULL,
	"labels" jsonb NOT NULL,
	"resource_limits" jsonb NOT NULL,
	"status" "container_status" NOT NULL,
	"exit_code" integer,
	"ttl_expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"exited_at" timestamp with time zone,
	"instance_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "containers_docker_id_unique" UNIQUE("docker_id")
);
--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_parent_id_containers_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."containers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_instance_id_cogmo_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."cogmo_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_containers_instance_id" ON "containers" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "idx_containers_root_task_id" ON "containers" USING btree ("root_task_id");--> statement-breakpoint
CREATE INDEX "idx_containers_status_ttl" ON "containers" USING btree ("status","ttl_expires_at");