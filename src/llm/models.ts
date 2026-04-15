/**
 * Model registry — maps model identifiers to capabilities.
 *
 * Curated allowlist. Unknown models fail with a clear error.
 * When adding a new model to a profile, add it here at the same time.
 *
 * Slug conventions:
 *  - Anthropic native (via Anthropic SDK): `claude-{tier}-{major}-{minor}` and
 *    occasionally a date suffix (e.g. `claude-haiku-4-5-20251001`).
 *  - OpenRouter (via OpenAI-compatible SDK): `{org}/{model}` with the
 *    org-canonical model id (e.g. `anthropic/claude-opus-4.6`,
 *    `x-ai/grok-4.20`, `google/gemini-2.5-pro`).
 *  - Bare `gpt-4o` etc. are OpenAI direct.
 */

export interface ModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
}

const MODEL_REGISTRY: ReadonlyMap<string, ModelLimits> = new Map([
  // --- Anthropic (direct via Anthropic SDK) ---
  ["claude-opus-4-6", { contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
  ["claude-sonnet-4-6", { contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
  ["claude-haiku-4-5-20251001", { contextWindow: 200_000, maxOutputTokens: 64_000 }],
  ["claude-opus-4-20250514", { contextWindow: 200_000, maxOutputTokens: 16_384 }],
  ["claude-sonnet-4-20250514", { contextWindow: 200_000, maxOutputTokens: 16_384 }],
  ["claude-haiku-3-5-20241022", { contextWindow: 200_000, maxOutputTokens: 8_192 }],

  // --- OpenAI (direct) ---
  ["gpt-4o", { contextWindow: 128_000, maxOutputTokens: 16_384 }],
  ["gpt-4o-mini", { contextWindow: 128_000, maxOutputTokens: 16_384 }],

  // --- OpenRouter (OpenAI-compatible SDK) ---
  // Anthropic via OpenRouter
  ["anthropic/claude-opus-4.6", { contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
  ["anthropic/claude-sonnet-4.6", { contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
  ["anthropic/claude-haiku-4.5", { contextWindow: 200_000, maxOutputTokens: 64_000 }],
  // xAI Grok
  ["x-ai/grok-4.20", { contextWindow: 2_000_000, maxOutputTokens: 32_000 }],
  ["x-ai/grok-4.1-fast", { contextWindow: 2_000_000, maxOutputTokens: 30_000 }],
  // Google Gemini
  ["google/gemini-2.5-pro", { contextWindow: 1_048_576, maxOutputTokens: 65_536 }],
  ["google/gemini-2.5-flash", { contextWindow: 1_048_576, maxOutputTokens: 65_536 }],
  // OpenAI flagship + mid-tier via OpenRouter
  ["openai/gpt-5.4", { contextWindow: 1_050_000, maxOutputTokens: 128_000 }],
  ["openai/gpt-5.4-mini", { contextWindow: 400_000, maxOutputTokens: 128_000 }],
  // DeepSeek — cheap open-weights with tool support
  ["deepseek/deepseek-v3.2", { contextWindow: 163_840, maxOutputTokens: 8_192 }],
]);

const DEFAULT_SAFETY_BUFFER = 10_000;

/**
 * Get context window and output limits for a model.
 * Throws on unknown models — misconfiguration should be caught early.
 */
export function getModelLimits(model: string): ModelLimits {
  const limits = MODEL_REGISTRY.get(model);
  if (!limits) {
    throw new Error(`Unknown model "${model}" — add it to MODEL_REGISTRY in src/llm/models.ts`);
  }
  return limits;
}

/**
 * Compute the input token budget for a model.
 * budget = contextWindow - maxOutputTokens - safetyBuffer
 */
export function computeBudget(model: string, safetyBuffer = DEFAULT_SAFETY_BUFFER): number {
  const { contextWindow, maxOutputTokens } = getModelLimits(model);
  return contextWindow - maxOutputTokens - safetyBuffer;
}
