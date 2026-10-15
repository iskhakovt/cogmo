import {
  type AttachmentBudget,
  type AttachmentLimits,
  attachmentBudget,
} from "../../llm/attachment-limits.js";
import { computeBudget, type ResolvedLimits, resolveLimits } from "../../llm/models.js";
import type { LlmProvider } from "../../llm/provider.js";
import { MAX_VIEW_BYTES, viewBytesFor } from "../../llm/request-size.js";
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
  limits: FrozenLimits;
  /** The input budget compaction sizes the view against. */
  budget: number;
  /** Strategy 1's edit intent, on every request of the turn. */
  clearToolResults: ToolResultClearing;
  /**
   * What the view's attachments may weigh; null when the run's
   * `freeze-model-limits` memo predates attachment limits, which fixes no
   * cutoff.
   */
  attachmentBudget: AttachmentBudget | null;
  /** The size trigger's cap: the route's request cap less the wire overhead. */
  maxViewBytes: number;
}

/** The model's limits and its route's attachment limits, as `freeze-model-limits` memoizes them. */
export interface FrozenLimits extends ResolvedLimits {
  /** Absent in a memo written before attachment limits. */
  attachments?: AttachmentLimits;
}

/**
 * Resolve `model`'s limits and its route's attachment limits: the body of
 * `freeze-model-limits`, in chat and stage turns alike.
 */
export function freezeLimits(
  model: string,
  provider: Pick<LlmProvider, "attachmentLimits">,
  rowLimits: Parameters<typeof resolveLimits>[1],
): FrozenLimits {
  const limits = resolveLimits(model, rowLimits);
  return { ...limits, attachments: provider.attachmentLimits(limits.contextWindow) };
}

/** What a turn derives from its frozen limits. */
export function limitsPolicy(limits: FrozenLimits): {
  budget: number;
  clearToolResults: ToolResultClearing;
  attachmentBudget: AttachmentBudget | null;
  maxViewBytes: number;
} {
  const budget = computeBudget(limits);
  return {
    budget,
    // Derived from the frozen limits, so every invocation sends the same intent.
    clearToolResults: toolResultClearing(budget),
    attachmentBudget: limits.attachments ? attachmentBudget(limits.attachments) : null,
    maxViewBytes: limits.attachments
      ? viewBytesFor(limits.attachments.requestBytes)
      : MAX_VIEW_BYTES,
  };
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
  const limits = await stepRun("freeze-model-limits", async () =>
    freezeLimits(model, provider, rowLimits),
  );
  return { model, provider, limits, ...limitsPolicy(limits) };
}
