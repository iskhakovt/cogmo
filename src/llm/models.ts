/**
 * Model limits resolution.
 *
 * Cogmo doesn't curate a model allowlist — operators bring whatever model
 * id their provider exposes (`x-ai/grok-4.3`, `google/gemini-3-flash-preview`,
 * a niche local llama variant on a private vLLM box). The resolver answers
 * "what context window + max output budget does this model accept?" by
 * layering three sources, in priority order:
 *
 *   1. **DB row override** — the `(context_window, max_output_tokens)` columns
 *      on `model_providers`. Set by the setup wizard or `cogmo model add`
 *      when the operator wants explicit control. Highest priority — when
 *      either column is set we trust it without further lookup.
 *   2. **LiteLLM bundled snapshot** — `data/litellm-models.json`, refreshed
 *      manually via `scripts/refresh-litellm-models.ts`. Covers ~2,200
 *      models from the community-curated registry; bridges OpenRouter
 *      slugs to vendor-direct ids via key normalization.
 *   3. **Conservative default** — 128k context, 4k max output, with a
 *      `WARN` log so operators see the fallback fire and can pin explicit
 *      limits if compaction quality matters.
 *
 * Limits travel with the routing decision: the caller threads the row's
 * `(contextWindow, maxOutputTokens)` into {@link resolveLimits}, which
 * returns a fully-resolved {@link ModelLimits} plus a {@link LimitsSource}
 * tag so `cogmo model list` can show where each row's effective limits
 * came from.
 */

import { logger } from "../logger.js";
import { lookupLitellm } from "./litellm-data.js";

export interface ModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
}

/**
 * Where the resolver's returned limits came from. Useful for debugging
 * "why is compaction so aggressive on this model" and surfaced by
 * `cogmo model list` per row.
 */
export type LimitsSource = "db" | "litellm" | "default";

export interface ResolvedLimits extends ModelLimits {
  source: LimitsSource;
}

/**
 * Optional explicit override for a single model. Either column may be set
 * independently — for instance, an operator might pin `maxOutputTokens` on
 * a reasoning model to cap response length without overriding the context
 * window.
 */
export interface PartialLimits {
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

/**
 * Conservative fallback when a model is unknown to both DB overrides and
 * the LiteLLM snapshot. 128k / 4k is a safe lower bound: it under-uses
 * larger models (compaction fires earlier than necessary) but never
 * over-promises capacity that the upstream would reject. Compaction
 * quality is the only thing that suffers — operators can pin the real
 * values via the wizard or `cogmo model add` when they care.
 */
export const DEFAULT_LIMITS: ModelLimits = {
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
};

const DEFAULT_SAFETY_BUFFER = 10_000;

/**
 * Resolve the effective limits for a model.
 *
 * `rowLimits` are the DB columns from the `model_providers` row that's
 * being used for this turn (caller already did the routing lookup).
 * Pass `null` for either column when the row left it unset.
 *
 * Always returns a value — never throws on unknown models. When neither
 * the row nor the snapshot has a hit, logs a single `WARN` per model id
 * via the deduplicating cache so a long-running process doesn't spam
 * the same warning every turn.
 */
export function resolveLimits(model: string, rowLimits?: PartialLimits): ResolvedLimits {
  // Row override — only consult both columns. Treat half-set rows
  // (e.g. only `maxOutputTokens` set) as a partial override that fills
  // the missing field from the next layer down rather than the default.
  // This matches the operator's mental model: "I set this one knob, leave
  // the rest as the resolver decides."
  if (rowLimits?.contextWindow != null && rowLimits.maxOutputTokens != null) {
    return {
      contextWindow: rowLimits.contextWindow,
      maxOutputTokens: rowLimits.maxOutputTokens,
      source: "db",
    };
  }

  const litellm = lookupLitellm(model);
  const partial: Partial<ModelLimits> = {
    ...(rowLimits?.contextWindow != null && { contextWindow: rowLimits.contextWindow }),
    ...(rowLimits?.maxOutputTokens != null && { maxOutputTokens: rowLimits.maxOutputTokens }),
  };

  if (litellm) {
    const merged: ResolvedLimits = {
      contextWindow: partial.contextWindow ?? litellm.contextWindow,
      maxOutputTokens: partial.maxOutputTokens ?? litellm.maxOutputTokens,
      // If the row set anything at all, treat the result as a `db` source
      // so listing surfaces the override. Otherwise it's a clean LiteLLM hit.
      source: partial.contextWindow != null || partial.maxOutputTokens != null ? "db" : "litellm",
    };
    return merged;
  }

  warnFallbackOnce(model);
  return {
    contextWindow: partial.contextWindow ?? DEFAULT_LIMITS.contextWindow,
    maxOutputTokens: partial.maxOutputTokens ?? DEFAULT_LIMITS.maxOutputTokens,
    // Half-set + LiteLLM miss = still a `db` partial override; otherwise default.
    source: partial.contextWindow != null || partial.maxOutputTokens != null ? "db" : "default",
  };
}

const warnedModels = new Set<string>();

function warnFallbackOnce(model: string): void {
  if (warnedModels.has(model)) return;
  warnedModels.add(model);
  logger.warn(
    {
      model,
      defaultContextWindow: DEFAULT_LIMITS.contextWindow,
      defaultMaxOutputTokens: DEFAULT_LIMITS.maxOutputTokens,
    },
    `model "${model}" not in LiteLLM snapshot — using conservative default. ` +
      `Set explicit limits via the setup wizard or \`cogmo model add --context N --max-output N\` ` +
      `for accurate compaction.`,
  );
}

/**
 * Compute the input-token budget for a turn given resolved model limits.
 *
 *   budget = contextWindow - maxOutputTokens - safetyBuffer
 *
 * `safetyBuffer` defaults to 10k tokens — leaves headroom for tool
 * definitions, system prompt, and the reply priming that the SDK's
 * `countTokens` doesn't account for cleanly across providers.
 */
export function computeBudget(limits: ModelLimits, safetyBuffer = DEFAULT_SAFETY_BUFFER): number {
  return limits.contextWindow - limits.maxOutputTokens - safetyBuffer;
}
