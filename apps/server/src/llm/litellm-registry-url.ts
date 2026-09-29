/**
 * Where LiteLLM publishes its model registry. A module of its own so `env.ts`
 * can default `MODEL_CATALOG_URL` to it without loading the LLM modules.
 */
export const LITELLM_REGISTRY_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
