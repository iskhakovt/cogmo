import { and, asc, eq } from "drizzle-orm";
import type { Result } from "neverthrow";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import { inSavepoint, type SubAgentNameTaken, uniqueViolationAs } from "./errors.js";
import { subAgents } from "./schema.js";

/**
 * A row from `sub_agents`. `systemPrompt` is null for a pure model-as-tool
 * sub-agent (no standing persona); `model` routes via the LlmProviderResolver.
 */
export interface SubAgent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string | null;
  model: string;
}

/** The `sub_agents` rows: a user's catalog of models the orchestrator delegates to as tools. */
export interface SubAgentStore {
  /**
   * List a user's sub-agents, ordered by name for stable tool-catalog output
   * across turns. The per-turn tool builder turns each into a
   * `subagent__<name>` tool; `profiles.tool_set` then gates which surface for
   * a given profile.
   */
  listSubAgents(tx: Transaction, userId: string): Promise<ReadonlyArray<SubAgent>>;

  /**
   * Insert a sub-agent. The caller (the create-sub-agent use case)
   * validates the name shape and that `model` exists in `model_providers`
   * first.
   */
  createSubAgent(
    tx: Transaction,
    params: {
      userId: string;
      name: string;
      description: string;
      systemPrompt: string | null;
      model: string;
    },
  ): Promise<Result<{ id: string }, SubAgentNameTaken>>;

  /** Delete a sub-agent by name. `deleted: false` when no row matched. */
  deleteSubAgent(tx: Transaction, userId: string, name: string): Promise<{ deleted: boolean }>;
}

export class DrizzleSubAgentStore implements SubAgentStore {
  async listSubAgents(tx: Transaction, userId: string): Promise<ReadonlyArray<SubAgent>> {
    return tx
      .select()
      .from(subAgents)
      .where(eq(subAgents.userId, userId))
      .orderBy(asc(subAgents.name));
  }

  async createSubAgent(
    tx: Transaction,
    params: {
      userId: string;
      name: string;
      description: string;
      systemPrompt: string | null;
      model: string;
    },
  ): Promise<Result<{ id: string }, SubAgentNameTaken>> {
    return inSavepoint(tx, (sp) =>
      uniqueViolationAs(
        "uq_sub_agents_user_name",
        { kind: "sub_agent_name_taken", name: params.name } as const,
        async () =>
          single(await sp.insert(subAgents).values(params).returning({ id: subAgents.id })),
      ),
    );
  }

  async deleteSubAgent(
    tx: Transaction,
    userId: string,
    name: string,
  ): Promise<{ deleted: boolean }> {
    const deleted = await tx
      .delete(subAgents)
      .where(and(eq(subAgents.userId, userId), eq(subAgents.name, name)))
      .returning({ id: subAgents.id });
    return { deleted: deleted.length > 0 };
  }
}
