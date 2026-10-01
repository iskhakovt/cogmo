import { pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { pk, ts } from "../../../db/helpers.js";
import { users } from "./users.js";

/**
 * Per-user catalog of sub-agents — specialist models the orchestrator can
 * delegate a subtask to as a tool. A sub-agent is a *binding* over a model
 * already routable via `model_providers` + the resolver: it reuses that
 * model's provider/credentials/limits and adds the two things delegation
 * needs that a bare model id lacks.
 *
 * - `name` is the LLM-facing handle. The tool builder surfaces each row as a
 *   tool named `subagent__<name>` (namespaced like MCP's `mcp__<server>__`),
 *   so sub-agent tools can never collide with a built-in and a profile can
 *   opt into all of them with a `subagent__*` glob.
 * - `description` is read by the *orchestrator* to decide when to delegate —
 *   the routing signal. Required: without it the orchestrator routes blind.
 * - `system_prompt` is read by the *sub-agent model* as standing behaviour
 *   across every call. Nullable: NULL = pure model-as-tool (the orchestrator's
 *   per-call task carries all instruction — e.g. a strong reasoning model that
 *   can't run tools); set = a persona/format/policy reused across calls.
 * - `model` is validated to exist in `model_providers` at write time but is
 *   NOT `user_selectable`-gated — like `profiles.summarization_model`, it's an
 *   internal-use model that needn't appear in the `/model` picker. It's free
 *   text, not an FK: `model_providers` has no unique key on `model` alone
 *   (only `(model, position)` / `(model, provider_id)`), so an FK has no target
 *   and the same dangle as `profiles.model` applies — a later `cogmo model
 *   remove` can orphan it, after which the tool surfaces a clear "no provider
 *   configured" error at call time rather than failing the delete.
 *
 * **Availability is per-profile, not on this row.** Which profiles may call a
 * sub-agent is expressed through `profiles.tool_set` globs (the same mechanism
 * that gates built-ins, skills, and MCP tools) — there is no profile↔sub-agent
 * join table. `tool_set` holds plain strings with no FK, so deleting a row just
 * makes the tool vanish from profiles next turn (no dangling references).
 */
export const subAgents = pgTable(
  "sub_agents",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    systemPrompt: text("system_prompt"), // null = pure model-as-tool (no standing persona)
    model: text("model").notNull(), // resolved via LlmProviderResolver; validated against model_providers at write time
    createdAt: ts(),
  },
  (t) => [unique("uq_sub_agents_user_name").on(t.userId, t.name)],
);
