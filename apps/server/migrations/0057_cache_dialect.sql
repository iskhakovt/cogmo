-- `llm_providers.attrs.cacheDialect` replaces the `promptCaching` boolean,
-- which could only say "OpenRouter". Each OpenAI-compatible row's dialect is
-- set once: an explicit `promptCaching: false`, an operator's opt-out, becomes
-- `none`; otherwise the base-URL host decides, by the rule
-- `cacheDialectForBaseUrl` applies to new rows (the host trimmed as a URL
-- parser trims it, subdomains included for the vendors' regional endpoints):
--   openrouter.ai  -> openrouter
--   api.openai.com -> openai
--   api.x.ai       -> xai
-- and any other host gives `openrouter` if `promptCaching` is `true` (an
-- `openrouter`-type row behind a proxy), else `none`.
-- Anthropic rows take no dialect and only lose the old key.
UPDATE "llm_providers" AS p
SET "attrs" = (p."attrs" - 'promptCaching') || jsonb_build_object(
  'cacheDialect',
  CASE
    WHEN p."attrs" -> 'promptCaching' = 'false'::jsonb THEN 'none'
    WHEN h."host" ~ '(^|\.)openrouter\.ai$' THEN 'openrouter'
    WHEN h."host" ~ '(^|\.)api\.openai\.com$' THEN 'openai'
    WHEN h."host" ~ '(^|\.)api\.x\.ai$' THEN 'xai'
    WHEN p."attrs" -> 'promptCaching' = 'true'::jsonb THEN 'openrouter'
    ELSE 'none'
  END
)
FROM (
  SELECT
    "id",
    lower(substring(btrim("base_url", E' \t\n\r') from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?([^/?#:]+)')) AS "host"
  FROM "llm_providers"
) AS h
WHERE h."id" = p."id" AND p."type" = 'openai_compatible';--> statement-breakpoint
UPDATE "llm_providers"
SET "attrs" = "attrs" - 'promptCaching'
WHERE "type" <> 'openai_compatible';
