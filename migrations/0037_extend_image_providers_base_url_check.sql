-- Extend `chk_image_providers_base_url` to cover the `venice` type that
-- 0036 added to `image_provider_type`. Mirrors `openai_compatible`'s
-- "base_url required" posture (venice's native endpoint takes a base_url
-- like `https://api.venice.ai/api/v1`). Hand-rolled adapter; see
-- `src/llm/venice.ts`.

ALTER TABLE "image_providers" DROP CONSTRAINT "chk_image_providers_base_url";--> statement-breakpoint
ALTER TABLE "image_providers" ADD CONSTRAINT "chk_image_providers_base_url" CHECK (("image_providers"."type" <> 'openai_compatible' OR "image_providers"."base_url" IS NOT NULL)
        AND ("image_providers"."type" <> 'venice' OR "image_providers"."base_url" IS NOT NULL)
        AND ("image_providers"."type" <> 'fal' OR "image_providers"."base_url" IS NULL));
