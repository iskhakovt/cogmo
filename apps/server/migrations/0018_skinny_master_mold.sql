CREATE TYPE "public"."mcp_server_approval_status" AS ENUM('pending', 'approved', 'needs_reapproval');--> statement-breakpoint
CREATE TYPE "public"."mcp_tool_approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "mcp_server_tools" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"server_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"schema_hash" text NOT NULL,
	"schema_snapshot" jsonb NOT NULL,
	"approval_status" "mcp_tool_approval_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_mcp_server_tool" UNIQUE("server_id","tool_name")
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean NOT NULL,
	"approval_status" "mcp_server_approval_status" NOT NULL,
	"last_connected_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "mcp_server_tools" ADD CONSTRAINT "mcp_server_tools_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;