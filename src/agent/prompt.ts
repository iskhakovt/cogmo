import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { steeringRules } from "../db/schema.js";

const BASE_PROMPT = `You are a personal AI assistant. You are helpful, concise, and direct.

You have access to tools — use them when they help answer the user's question.
If you don't know something and don't have a tool for it, say so honestly.`;

/**
 * Assemble the full system prompt from base prompt + active steering rules.
 *
 * Steering rules are loaded from the database and appended as a bullet list.
 * This keeps the prompt dynamic — rules can be added/modified without code changes.
 */
export async function assembleSystemPrompt(db: Database): Promise<string> {
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
