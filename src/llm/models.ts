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
  ["claude-opus-4-7", { contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
  ["claude-opus-4-6", { contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
  ["claude-opus-4-5-20251101", { contextWindow: 200_000, maxOutputTokens: 64_000 }],
  ["claude-opus-4-1-20250805", { contextWindow: 200_000, maxOutputTokens: 32_000 }],
  ["claude-sonnet-4-6", { contextWindow: 1_000_000, maxOutputTokens: 64_000 }],
  ["claude-sonnet-4-5-20250929", { contextWindow: 200_000, maxOutputTokens: 64_000 }],
  ["claude-haiku-4-5-20251001", { contextWindow: 200_000, maxOutputTokens: 64_000 }],

  // --- OpenAI (direct) ---
  ["gpt-5.5", { contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
  ["gpt-5.4", { contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
  ["gpt-5.4-mini", { contextWindow: 400_000, maxOutputTokens: 128_000 }],
  ["gpt-4o", { contextWindow: 128_000, maxOutputTokens: 16_384 }],
  ["gpt-4o-mini", { contextWindow: 128_000, maxOutputTokens: 16_384 }],

  // --- OpenRouter (OpenAI-compatible SDK) ---
  // Anthropic via OpenRouter
  ["anthropic/claude-opus-4.7", { contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
  ["anthropic/claude-opus-4.6", { contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
  ["anthropic/claude-sonnet-4.6", { contextWindow: 1_000_000, maxOutputTokens: 64_000 }],
  ["anthropic/claude-haiku-4.5", { contextWindow: 200_000, maxOutputTokens: 64_000 }],
  // xAI Grok
  ["x-ai/grok-4.3", { contextWindow: 1_000_000, maxOutputTokens: 32_000 }],
  ["x-ai/grok-4.20", { contextWindow: 2_000_000, maxOutputTokens: 32_000 }],
  ["x-ai/grok-4.1-fast", { contextWindow: 2_000_000, maxOutputTokens: 30_000 }],
  ["x-ai/grok-4-fast", { contextWindow: 2_000_000, maxOutputTokens: 30_000 }],
  // Google Gemini
  ["google/gemini-3-flash-preview", { contextWindow: 1_048_576, maxOutputTokens: 65_536 }],
  ["google/gemini-2.5-pro", { contextWindow: 1_048_576, maxOutputTokens: 65_536 }],
  ["google/gemini-2.5-flash", { contextWindow: 1_048_576, maxOutputTokens: 65_535 }],
  ["google/gemini-2.5-flash-lite", { contextWindow: 1_048_576, maxOutputTokens: 65_535 }],
  // OpenAI flagship + mid-tier via OpenRouter
  ["openai/gpt-5.5", { contextWindow: 1_050_000, maxOutputTokens: 128_000 }],
  ["openai/gpt-5.4", { contextWindow: 1_050_000, maxOutputTokens: 128_000 }],
  ["openai/gpt-5.4-mini", { contextWindow: 400_000, maxOutputTokens: 128_000 }],
  ["openai/gpt-oss-120b", { contextWindow: 131_072, maxOutputTokens: 32_768 }],
  // DeepSeek — cheap open-weights with tool support
  ["deepseek/deepseek-v4-pro", { contextWindow: 1_048_576, maxOutputTokens: 32_768 }],
  ["deepseek/deepseek-v4-flash", { contextWindow: 1_048_576, maxOutputTokens: 32_768 }],
  ["deepseek/deepseek-v3.2", { contextWindow: 163_840, maxOutputTokens: 8_192 }],
  // Moonshot Kimi — long-context Chinese MoE, OpenAI-compatible tools
  ["moonshotai/kimi-k2.6", { contextWindow: 262_144, maxOutputTokens: 16_384 }],
  // MiniMax
  ["minimax/minimax-m2.7", { contextWindow: 196_608, maxOutputTokens: 32_768 }],
  // Z-AI (Zhipu) GLM
  ["z-ai/glm-5.1", { contextWindow: 202_752, maxOutputTokens: 65_535 }],
  // Tencent Hunyuan — paid + free tier (same wire shape, same limits)
  ["tencent/hy3-preview", { contextWindow: 262_144, maxOutputTokens: 65_536 }],
  ["tencent/hy3-preview:free", { contextWindow: 262_144, maxOutputTokens: 65_536 }],
  // StepFun
  ["stepfun/step-3.5-flash", { contextWindow: 262_144, maxOutputTokens: 32_768 }],
  // NVIDIA Nemotron — free tier
  [
    "nvidia/nemotron-3-super-120b-a12b:free",
    {
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
    },
  ],
  // OpenRouter's own preview model
  ["openrouter/owl-alpha", { contextWindow: 1_048_576, maxOutputTokens: 262_144 }],
]);

const DEFAULT_SAFETY_BUFFER = 10_000;

/**
 * Get context window and output limits for a model.
 * Throws on unknown models — misconfiguration should be caught early.
 *
 * INVARIANT: only ever called with the current turn's model resolved from
 * `profiles.model` (via `snapshot.model` in `handle-message.ts`). Historical
 * `messages.model` rows are write-only and may reference retired/deprecated
 * ids that are no longer in the registry — never route those through here.
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
