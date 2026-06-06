/**
 * Create a sub-agent — the domain use case shared by `cogmo subagent add` and
 * any future wizard / Transport surface.
 *
 * Validates the name shape (so `subagent__<name>` is a legal tool name) and
 * that `model` is routable via `model_providers`, then inserts the row. The
 * model is **not** `user_selectable`-gated: a sub-agent is an internal-use
 * model (like `profiles.summarization_model`), so it may point at a model the
 * `/model` picker hides. A `(user_id, name)` collision surfaces as
 * `UniqueViolationError` from the store.
 */
import type { Transactor } from "../../db/index.js";
import { InvalidNameError, UnknownModelError } from "../store/errors.js";
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

export async function createSubAgent(
  deps: CreateSubAgentDeps,
  args: CreateSubAgentArgs,
): Promise<{ id: string }> {
  if (!SUB_AGENT_NAME_RE.test(args.name)) {
    throw new InvalidNameError(args.name, "sub_agent");
  }
  // `description` is the routing signal the orchestrator reads to decide when to
  // delegate. The column is NOT NULL but "" satisfies it — enforce non-empty
  // here so every surface (CLI, future wizard / Transport) inherits the rule.
  if (args.description.trim().length === 0) {
    throw new Error("sub-agent description must not be empty (it is the routing signal)");
  }
  return deps.runInTx(async (tx) => {
    const providers = await deps.agentStore.listProvidersForModel(tx, args.model);
    if (providers.length === 0) {
      throw new UnknownModelError(args.model);
    }
    return deps.agentStore.createSubAgent(tx, {
      userId: args.userId,
      name: args.name,
      description: args.description,
      systemPrompt: args.systemPrompt,
      model: args.model,
    });
  });
}
