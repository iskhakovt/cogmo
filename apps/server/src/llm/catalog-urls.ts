/**
 * Where the model catalog's sources publish. A module of its own so `env.ts`
 * can default `MODEL_CATALOG_URL` and `MODEL_CATALOG_OPENROUTER_URL` to them
 * without loading the LLM modules.
 */
export const LITELLM_REGISTRY_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
