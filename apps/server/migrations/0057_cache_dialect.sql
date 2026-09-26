-- `llm_providers.attrs.cacheDialect` replaces the `promptCaching` boolean,
-- which could only say "OpenRouter". The dialect is derived once from each
-- OpenAI-compatible row's base-URL host, the same rule `addProvider` applies
-- to new rows:
--   openrouter.ai  -> openrouter
--   api.openai.com -> openai
--   api.x.ai       -> xai
--   anything else  -> none
-- Anthropic rows take no dialect and only lose the old key.
UPDATE "llm_providers"
SET "attrs" = ("attrs" - 'promptCaching') || jsonb_build_object(
  'cacheDialect',
  CASE lower(substring("base_url" from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?([^/?#:]+)'))
    WHEN 'openrouter.ai' THEN 'openrouter'
    WHEN 'api.openai.com' THEN 'openai'
    WHEN 'api.x.ai' THEN 'xai'
    ELSE 'none'
  END
)
WHERE "type" = 'openai_compatible';--> statement-breakpoint
UPDATE "llm_providers"
SET "attrs" = "attrs" - 'promptCaching'
WHERE "type" <> 'openai_compatible';
