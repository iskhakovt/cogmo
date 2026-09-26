/**
 * Provider catalog shared by the interactive wizard and non-interactive setup.
 *
 * Single source of truth for which provider types we support and their default
 * base URLs. Any setup path adding a provider must consult this module.
 */

import type { CacheDialect } from "../llm/cache-dialect.js";

/** Provider types the wizard knows how to configure. */
export const PROVIDER_TYPES = ["anthropic", "openrouter", "openai", "custom"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** Default base URL per provider type (undefined = SDK default or user-supplied). */
export const PROVIDER_BASE_URLS: Record<ProviderType, string | undefined> = {
  anthropic: undefined,
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  custom: undefined,
};

/**
 * The cache dialect a provider type fixes whatever its base URL — an
 * `openrouter` row behind a proxy still speaks OpenRouter's. Undefined leaves
 * it to the base URL's host (`addProvider`); an operator's explicit dialect
 * wins over both.
 */
export const PROVIDER_CACHE_DIALECTS: Record<ProviderType, CacheDialect | undefined> = {
  anthropic: undefined,
  openrouter: "openrouter",
  openai: undefined,
  custom: undefined,
};
