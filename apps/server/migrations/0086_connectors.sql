CREATE TYPE "public"."connector_kind" AS ENUM('coding');--> statement-breakpoint
CREATE TYPE "public"."connector_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"kind" "connector_kind" NOT NULL,
	"status" "connector_status" NOT NULL,
	"token_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connectors_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "chk_connectors_revoked_at" CHECK (("connectors"."status" = 'revoked') = ("connectors"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connectors_active_name" ON "connectors" USING btree ("name") WHERE status = 'active'::connector_status;