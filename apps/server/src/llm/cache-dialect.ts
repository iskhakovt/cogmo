/**
 * Which caching and routing hints an OpenAI-compatible endpoint takes for a
 * cache intent — `llm_providers.attrs.cacheDialect`, mapped onto the wire by
 * `OpenAICompatibleProvider` (see design/prompt-caching.md → Adapter mapping):
 *
 * - `openrouter` — `session_id`, plus Anthropic `cache_control` markers on the
 *   `anthropic/`, `google/` and `qwen/` models that honour them.
 * - `openai` — `prompt_cache_key`.
 * - `xai` — the `x-grok-conv-id` request header.
 * - `none` — nothing; strict servers reject fields they don't know.
 */

import { z } from "zod";

export const CacheDialectSchema = z.enum(["openrouter", "openai", "xai", "none"]);
export type CacheDialect = z.infer<typeof CacheDialectSchema>;

/**
 * API hosts whose dialect is known. Each also covers its subdomains, where the
 * vendors put their regional endpoints (`eu.openrouter.ai`,
 * `eu.api.openai.com`, `us.api.x.ai`). Migration 0057 applies the same table
 * in SQL.
 */
const DIALECT_BY_HOST: ReadonlyArray<readonly [string, CacheDialect]> = [
  ["openrouter.ai", "openrouter"],
  ["api.openai.com", "openai"],
  ["api.x.ai", "xai"],
];

/**
 * The dialect an endpoint speaks, judged by its base URL's host; `none` for any
 * other host or a URL that doesn't parse. Applied when a provider row is
 * written — the dialect is stored configuration, never re-derived per request.
 */
export function cacheDialectForBaseUrl(baseUrl: string): CacheDialect {
  if (!URL.canParse(baseUrl)) return "none";
  const { hostname } = new URL(baseUrl);
  const match = DIALECT_BY_HOST.find(
    ([host]) => hostname === host || hostname.endsWith(`.${host}`),
  );
  return match?.[1] ?? "none";
}
