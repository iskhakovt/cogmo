-- Rewrite references to Anthropic-deprecated model ids (retiring 2026-06-15)
-- to their recommended replacements:
--   claude-sonnet-4-20250514 -> claude-sonnet-4-6
--   claude-opus-4-20250514   -> claude-opus-4-7
-- Source: https://platform.claude.com/docs/en/about-claude/model-deprecations
--
-- `messages.model` is intentionally NOT rewritten — it's a per-turn audit
-- trail of what actually ran, and the registry no longer accepts these ids
-- so it can't be re-derived. Leave the historical record intact.

-- model_providers: dedup before rename to avoid violating either of:
--   unique(model, provider_id) -- another row already maps the new id to the same provider
--   unique(model, position)    -- after rename, two rows would share (new_model, position)
-- Drop the old-id row whenever a same-provider new-id row already exists, then UPDATE the rest.
DELETE FROM "model_providers"
WHERE "model" = 'claude-sonnet-4-20250514'
  AND EXISTS (
    SELECT 1 FROM "model_providers" m2
    WHERE m2."model" = 'claude-sonnet-4-6'
      AND m2."provider_id" = "model_providers"."provider_id"
  );--> statement-breakpoint
DELETE FROM "model_providers"
WHERE "model" = 'claude-opus-4-20250514'
  AND EXISTS (
    SELECT 1 FROM "model_providers" m2
    WHERE m2."model" = 'claude-opus-4-7'
      AND m2."provider_id" = "model_providers"."provider_id"
  );--> statement-breakpoint
-- Position conflict: if (old_model, X, pos=N) and (new_model, Y, pos=N) coexist after the
-- provider-level dedup above, renaming would violate unique(model, position). Bump the
-- old row to the next free position for new_model before the rename.
UPDATE "model_providers" AS old
SET "position" = sub."next_pos"
FROM (
  SELECT
    mp."id",
    COALESCE(MAX(other."position"), -1) + 1
      + ROW_NUMBER() OVER (PARTITION BY mp."model" ORDER BY mp."position") - 1
      AS "next_pos"
  FROM "model_providers" mp
  LEFT JOIN "model_providers" other
    ON other."model" = CASE
      WHEN mp."model" = 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
      WHEN mp."model" = 'claude-opus-4-20250514'   THEN 'claude-opus-4-7'
    END
  WHERE mp."model" IN ('claude-sonnet-4-20250514', 'claude-opus-4-20250514')
    AND EXISTS (
      SELECT 1 FROM "model_providers" conflict
      WHERE conflict."model" = CASE
        WHEN mp."model" = 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
        WHEN mp."model" = 'claude-opus-4-20250514'   THEN 'claude-opus-4-7'
      END
        AND conflict."position" = mp."position"
    )
  GROUP BY mp."id", mp."model", mp."position"
) AS sub
WHERE old."id" = sub."id";--> statement-breakpoint
UPDATE "model_providers"
SET "model" = CASE
  WHEN "model" = 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
  WHEN "model" = 'claude-opus-4-20250514'   THEN 'claude-opus-4-7'
END
WHERE "model" IN ('claude-sonnet-4-20250514', 'claude-opus-4-20250514');--> statement-breakpoint

-- profiles: rewrite all three model columns. No uniqueness constraints
-- on these columns, so a plain UPDATE is sufficient.
UPDATE "profiles"
SET "model" = CASE
  WHEN "model" = 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
  WHEN "model" = 'claude-opus-4-20250514'   THEN 'claude-opus-4-7'
END
WHERE "model" IN ('claude-sonnet-4-20250514', 'claude-opus-4-20250514');--> statement-breakpoint
UPDATE "profiles"
SET "summarization_model" = CASE
  WHEN "summarization_model" = 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
  WHEN "summarization_model" = 'claude-opus-4-20250514'   THEN 'claude-opus-4-7'
END
WHERE "summarization_model" IN ('claude-sonnet-4-20250514', 'claude-opus-4-20250514');--> statement-breakpoint
UPDATE "profiles"
SET "extraction_model" = CASE
  WHEN "extraction_model" = 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
  WHEN "extraction_model" = 'claude-opus-4-20250514'   THEN 'claude-opus-4-7'
END
WHERE "extraction_model" IN ('claude-sonnet-4-20250514', 'claude-opus-4-20250514');
