-- `llm_providers.attrs.cacheDialect` replaces the `promptCaching` boolean,
-- which could only say "OpenRouter". The dialect is derived once from each
-- OpenAI-compatible row's base-URL host, trimmed as a URL parser trims it,
-- by the rule `addProvider` applies to new rows:
--   openrouter.ai  -> openrouter
--   api.openai.com -> openai
--   api.x.ai       -> xai
--   anything else  -> none
-- An explicit `promptCaching: false` is an operator's opt-out — no writer
-- sets it — and becomes `none` whatever the host.
-- Anthropic rows take no dialect and only lose the old key.
UPDATE "llm_providers"
SET "attrs" = ("attrs" - 'promptCaching') || jsonb_build_object(
  'cacheDialect',
  CASE
    WHEN "attrs" -> 'promptCaching' = 'false'::jsonb THEN 'none'
    ELSE CASE lower(substring(btrim("base_url", E' \t\n\r') from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?([^/?#:]+)'))
      WHEN 'openrouter.ai' THEN 'openrouter'
      WHEN 'api.openai.com' THEN 'openai'
      WHEN 'api.x.ai' THEN 'xai'
      ELSE 'none'
    END
  END
)
WHERE "type" = 'openai_compatible';--> statement-breakpoint
UPDATE "llm_providers"
SET "attrs" = "attrs" - 'promptCaching'
WHERE "type" <> 'openai_compatible';
