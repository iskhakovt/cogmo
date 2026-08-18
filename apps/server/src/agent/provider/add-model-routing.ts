/**
 * Add a model-routing entry — domain use case shared by the wizard's model
 * picker step and `cogmo model add`.
 *
 * Inserts a `model_providers` row pointing the given model id at the given
 * provider, optionally with explicit context-window / max-output overrides
 * that the resolver will treat as authoritative. Picks the next free
 * `position` for the model when one isn't supplied so the
 * `(model, position)` UNIQUE constraint never trips on a default.
 */
import type { Transactor } from "../../db/index.js";
import type { AgentStore } from "../store/index.js";

export interface AddModelRoutingArgs {
  model: string;
  providerId: string;
  /**
   * Hide the model from the user-facing `/model` picker. Defaults to
   * `true` — internal-only models (summarization, experimental) should
   * pass `false`.
   */
  userSelectable?: boolean;
  /**
   * Position in the fallback chain for this model. When omitted, picks
   * the next available value via {@link AgentStore.getNextModelProviderPosition}
   * so the UNIQUE constraint on `(model, position)` doesn't trip.
   */
  position?: number;
  /**
   * Optional explicit override. Leave `undefined` to let the resolver fall
   * back through LiteLLM JSON → conservative default.
   */
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
}

export interface AddModelRoutingDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
}

/**
 * Reject a limit that cannot describe a real model. Zero max-output makes
 * every request built from the row invalid, and zero context window drives
 * the turn budget negative — both are more usefully refused at the point
 * of entry than resolved around later.
 */
function assertPositiveLimit(label: string, value: number | null | undefined): void {
  if (value != null && value <= 0) {
    throw new Error(`${label} must be a positive number of tokens, got ${value}`);
  }
}

export async function addModelRouting(
  deps: AddModelRoutingDeps,
  args: AddModelRoutingArgs,
): Promise<{ id: string; position: number }> {
  assertPositiveLimit("contextWindow", args.contextWindow);
  assertPositiveLimit("maxOutputTokens", args.maxOutputTokens);
  return deps.runInTx(async (tx) => {
    const position =
      args.position ?? (await deps.agentStore.getNextModelProviderPosition(tx, args.model));
    const { id } = await deps.agentStore.addModelProvider(tx, {
      model: args.model,
      providerId: args.providerId,
      position,
      userSelectable: args.userSelectable ?? true,
      contextWindow: args.contextWindow ?? null,
      maxOutputTokens: args.maxOutputTokens ?? null,
    });
    return { id, position };
  });
}
