CREATE TYPE "public"."image_provider_type" AS ENUM('fal', 'openai_compatible');--> statement-breakpoint
CREATE TYPE "public"."llm_provider_type" AS ENUM('anthropic', 'openai_compatible');--> statement-breakpoint
CREATE TABLE "image_models" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider_id" uuid NOT NULL,
	"name" text NOT NULL,
	"model_string" text NOT NULL,
	"description" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"user_selectable" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_models_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "image_providers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"type" "image_provider_type" NOT NULL,
	"base_url" text,
	"secret_id" uuid NOT NULL,
	"attrs" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_providers_name_unique" UNIQUE("name"),
	CONSTRAINT "chk_image_providers_base_url" CHECK (("image_providers"."type" = 'fal' AND "image_providers"."base_url" IS NULL) OR ("image_providers"."type" = 'openai_compatible' AND "image_providers"."base_url" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "llm_providers" ALTER COLUMN "type" SET DATA TYPE "public"."llm_provider_type" USING "type"::"public"."llm_provider_type";--> statement-breakpoint
ALTER TABLE "image_models" ADD CONSTRAINT "image_models_provider_id_image_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."image_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_providers" ADD CONSTRAINT "image_providers_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;