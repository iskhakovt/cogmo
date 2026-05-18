-- Add `venice` to image_provider_type and extend the base_url CHECK so the
-- new type carries the openai-compat-style "base_url required, https, no
-- trailing slash" rule. Hand-rolled adapter; see src/llm/image-providers.ts.

ALTER TYPE "public"."image_provider_type" ADD VALUE 'venice';--> statement-breakpoint

ALTER TABLE "image_providers" DROP CONSTRAINT "chk_image_providers_base_url";--> statement-breakpoint
ALTER TABLE "image_providers" ADD CONSTRAINT "chk_image_providers_base_url" CHECK (("image_providers"."type" <> 'openai_compatible' OR "image_providers"."base_url" IS NOT NULL)
        AND ("image_providers"."type" <> 'venice' OR "image_providers"."base_url" IS NOT NULL)
        AND ("image_providers"."type" <> 'fal' OR "image_providers"."base_url" IS NULL));
