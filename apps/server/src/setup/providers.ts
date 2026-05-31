/**
 * Provider catalog shared by the interactive wizard and non-interactive setup.
 *
 * Single source of truth for which provider types we support and their default
 * base URLs. Any setup path adding a provider must consult this module.
 */

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
