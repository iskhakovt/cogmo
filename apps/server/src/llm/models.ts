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
 * Where the resolver picked each individual column from. Useful for
 * debugging "why is compaction so aggressive on this model" via
 * `cogmo model list`, where each row shows the source per column —
 * a partial DB override (e.g. only `maxOutputTokens` pinned) reports
 * `db` for that column and `litellm` for the one falling through, so
 * operators can see the contribution of each layer.
 */
export type LimitsSource = "db" | "litellm" | "default";

export interface ResolvedLimits extends ModelLimits {
  contextWindowSource: LimitsSource;
  maxOutputTokensSource: LimitsSource;
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
  const litellm = lookupLitellm(model);
  const cw = pickColumn(
    rowLimits?.contextWindow,
    litellm?.contextWindow,
    DEFAULT_LIMITS.contextWindow,
  );
  const mo = pickColumn(
    rowLimits?.maxOutputTokens,
    litellm?.maxOutputTokens,
    DEFAULT_LIMITS.maxOutputTokens,
  );
  // Warn once when the model is unknown to LiteLLM AND no DB override
  // supplied either column — the resolver fell through to the
  // conservative default everywhere, and the operator probably wants to
  // know.
  if (cw.source === "default" && mo.source === "default") {
    warnFallbackOnce(model);
  }
  return {
    contextWindow: cw.value,
    maxOutputTokens: mo.value,
    contextWindowSource: cw.source,
    maxOutputTokensSource: mo.source,
  };
}

function pickColumn(
  override: number | null | undefined,
  litellm: number | undefined,
  fallback: number,
): { value: number; source: LimitsSource } {
  // A non-positive override is not a smaller budget but a nonsensical
  // one: zero max-output makes every request invalid, zero context window
  // drives `computeBudget` negative. Treated as unset, since the write
  // path cannot retract a value already sitting in the table.
  if (override != null && override > 0) return { value: override, source: "db" };
  if (litellm != null) return { value: litellm, source: "litellm" };
  return { value: fallback, source: "default" };
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
