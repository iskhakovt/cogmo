/**
 * Model registry — maps model identifiers to capabilities.
 *
 * Only models we actually use. Unknown models fail with a clear error.
 * When adding a new model to a profile, add it here at the same time.
 */

export interface ModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
}

const MODEL_REGISTRY: ReadonlyMap<string, ModelLimits> = new Map([
  // Anthropic
  ["claude-opus-4-20250514", { contextWindow: 200_000, maxOutputTokens: 16_384 }],
  ["claude-sonnet-4-20250514", { contextWindow: 200_000, maxOutputTokens: 16_384 }],
  ["claude-haiku-3-5-20241022", { contextWindow: 200_000, maxOutputTokens: 8_192 }],
  // OpenAI
  ["gpt-4o", { contextWindow: 128_000, maxOutputTokens: 16_384 }],
  ["gpt-4o-mini", { contextWindow: 128_000, maxOutputTokens: 16_384 }],
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
