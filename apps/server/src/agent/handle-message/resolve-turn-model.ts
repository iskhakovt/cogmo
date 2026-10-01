import { computeBudget, type ResolvedLimits, resolveLimits } from "../../llm/models.js";
import type { LlmProvider } from "../../llm/provider.js";
import {
  type LlmProviderResolver,
  ProviderConfigError,
  type ResolvedLlm,
} from "../../llm/resolver.js";
import type { ToolResultClearing } from "../../llm/types.js";
import { toolResultClearing } from "../context.js";
import type { StepRunner } from "../loop.js";
import { asNonRetriable } from "../turn-step-runner.js";

/**
 * Resolve a provider, rewrapping permanent config errors as
 * `NonRetriableError` so Inngest aborts on the first attempt instead of
 * burning all `retries: 2` attempts before `onFailure` notifies the user.
 * Transient errors (DB blip, network) keep their plain shape and follow
 * the default retry path.
 */
export async function resolveOrFail(
  resolveProvider: LlmProviderResolver,
  model: string,
): Promise<ResolvedLlm> {
  try {
    return await resolveProvider(model);
  } catch (err) {
    if (err instanceof ProviderConfigError) throw asNonRetriable(err);
    throw err;
  }
}

export interface TurnModel {
  model: string;
  provider: LlmProvider;
  limits: ResolvedLimits;
  /** The input budget compaction sizes the view against. */
  budget: number;
  /** Strategy 1's edit intent, on every request of the turn. */
  clearToolResults: ToolResultClearing;
}

/**
 * The turn's provider and its frozen limits.
 *
 * Per-turn provider dispatch — the snapshot's model determines which
 * adapter (Anthropic, xAI via OpenAI-compat, etc.) handles the chat,
 * streaming, and token-counting calls. Resolved outside any `step.run`
 * because the resolver returns an `LlmProvider` instance that isn't
 * JSON-serializable; the production resolver caches by model, so this is
 * one DB read + one AES decrypt the first time a model is seen, then a Map
 * lookup for the rest of the process. `resolveOrFail` rewraps permanent
 * config errors (no routing row, no secret, malformed `llm_providers` row)
 * as `NonRetriableError` so Inngest aborts immediately and `onFailure`
 * notifies the user — no point burning retries on a misconfiguration. See
 * design/providers.md → Provider dispatch.
 *
 * Step: `freeze-model-limits`.
 */
export async function resolveTurnModel(
  stepRun: StepRunner,
  resolveProvider: LlmProviderResolver,
  model: string,
): Promise<TurnModel> {
  const { provider, limits: rowLimits } = await resolveOrFail(resolveProvider, model);
  // Layered limits: row override → LiteLLM catalog → conservative
  // default. Durable: a catalog refresh landing between invocations
  // swaps the in-process catalog, and `budget` decides which
  // compaction steps the run plans.
  const limits = await stepRun("freeze-model-limits", async () => resolveLimits(model, rowLimits));
  const budget = computeBudget(limits);
  // Derived from the frozen limits, so every invocation sends the same intent.
  const clearToolResults = toolResultClearing(budget);
  return { model, provider, limits, budget, clearToolResults };
}
