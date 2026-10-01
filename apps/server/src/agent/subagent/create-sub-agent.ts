/**
 * Create a sub-agent — the domain use case shared by `cogmo subagent add` and
 * any future wizard / Transport surface.
 *
 * Validates the name shape (so `subagent__<name>` is a legal tool name) and
 * that `model` is routable via `model_providers`, then inserts the row. The
 * model is **not** `user_selectable`-gated: a sub-agent is an internal-use
 * model (like `profiles.summarization_model`), so it may point at a model the
 * `/model` picker hides.
 */
import { err, type Result } from "neverthrow";
import type { Transactor } from "../../db/index.js";
import type { InvalidName, SubAgentNameTaken } from "../store/errors.js";
import type { AgentStore } from "../store/index.js";
import { SUB_AGENT_NAME_RE } from "./sub-agent-tool-builder.js";

export interface CreateSubAgentArgs {
  userId: string;
  name: string;
  description: string;
  /** Standing persona/format/policy, or null for a pure model-as-tool. */
  systemPrompt: string | null;
  model: string;
}

export interface CreateSubAgentDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
}

/**
 * Why `createSubAgent` refused. `description_empty`: the description is the
 * routing signal the orchestrator delegates on. `unknown_model`: the model has
 * no row in `model_providers`, so a sub-agent on it could never run.
 */
export type CreateSubAgentError =
  | InvalidName
  | { kind: "description_empty" }
  | { kind: "unknown_model"; model: string }
  | SubAgentNameTaken;

export async function createSubAgent(
  deps: CreateSubAgentDeps,
  args: CreateSubAgentArgs,
): Promise<Result<{ id: string }, CreateSubAgentError>> {
  if (!SUB_AGENT_NAME_RE.test(args.name)) {
    return err({ kind: "invalid_name", name: args.name, subject: "sub_agent" });
  }
  // The column is NOT NULL but "" satisfies it; enforced here so every
  // surface inherits the rule.
  if (args.description.trim().length === 0) return err({ kind: "description_empty" });
  return deps.runInTx(async (tx): Promise<Result<{ id: string }, CreateSubAgentError>> => {
    const providers = await deps.agentStore.listProvidersForModel(tx, args.model);
    if (providers.length === 0) return err({ kind: "unknown_model", model: args.model });
    return deps.agentStore.createSubAgent(tx, {
      userId: args.userId,
      name: args.name,
      description: args.description,
      systemPrompt: args.systemPrompt,
      model: args.model,
    });
  });
}
