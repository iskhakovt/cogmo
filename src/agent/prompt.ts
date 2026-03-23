import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { steeringRules } from "../db/schema.js";

/**
 * Prompt source interface — the plugin contract for system prompt assembly.
 *
 * Implementations can load prompts from files, database, remote config, etc.
 * The orchestrator depends on this interface, never on a concrete source.
 */
export interface PromptSource {
  assemble(db: Database): Promise<string>;
}

const BASE_PROMPT = `You are a personal AI assistant. You are helpful, concise, and direct.

You have access to tools — use them when they help answer the user's question.
If you don't know something and don't have a tool for it, say so honestly.`;

/**
 * Default prompt source: hardcoded base prompt + steering rules from DB.
 */
export class DefaultPromptSource implements PromptSource {
  async assemble(db: Database): Promise<string> {
    const rules = await db
      .select({ rule: steeringRules.rule })
      .from(steeringRules)
      .where(eq(steeringRules.active, true))
      .orderBy(asc(steeringRules.priority));

    if (rules.length === 0) {
      return BASE_PROMPT;
    }

    const rulesList = rules.map((r) => `- ${r.rule}`).join("\n");
    return `${BASE_PROMPT}\n\nRules:\n${rulesList}`;
  }
}

/**
 * Convenience function for backward compatibility and simple usage.
 */
export async function assembleSystemPrompt(db: Database): Promise<string> {
  return new DefaultPromptSource().assemble(db);
}
