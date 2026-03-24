import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { profiles, steeringRules } from "../db/schema.js";

/**
 * Prompt source interface — the plugin contract for system prompt assembly.
 *
 * Implementations can load prompts from files, database, remote config, etc.
 * The orchestrator depends on this interface, never on a concrete source.
 */
export interface PromptSource {
  assemble(db: Database, profileId: string): Promise<string>;
}

const DEFAULT_BASE_PROMPT = `You are a personal AI assistant. You are helpful, concise, and direct.

You have access to tools — use them when they help answer the user's question.
If you don't know something and don't have a tool for it, say so honestly.`;

/**
 * Default prompt source: profile base prompt + steering rules from DB.
 */
export class DefaultPromptSource implements PromptSource {
  async assemble(db: Database, profileId: string): Promise<string> {
    // Load base prompt from profile
    const profile = await db
      .select({ basePrompt: profiles.basePrompt })
      .from(profiles)
      .where(eq(profiles.id, profileId))
      .limit(1);

    const basePrompt = profile[0]?.basePrompt ?? DEFAULT_BASE_PROMPT;

    // Load steering rules: global + profile-specific
    const rules = await db
      .select({ rule: steeringRules.rule })
      .from(steeringRules)
      .where(
        and(
          eq(steeringRules.active, true),
          or(isNull(steeringRules.profileId), eq(steeringRules.profileId, profileId)),
        ),
      )
      .orderBy(asc(steeringRules.priority));

    if (rules.length === 0) {
      return basePrompt;
    }

    const rulesList = rules.map((r) => `- ${r.rule}`).join("\n");
    return `${basePrompt}\n\nRules:\n${rulesList}`;
  }
}
