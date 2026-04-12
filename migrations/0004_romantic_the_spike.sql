CREATE TABLE "llm_providers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"base_url" text,
	"secret_id" uuid NOT NULL,
	"attrs" jsonb NOT NULL,
	"is_valid" boolean NOT NULL,
	"validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_providers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "provider_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_provider_id_llm_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE no action ON UPDATE no action;