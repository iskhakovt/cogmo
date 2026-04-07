import type { AgentStore } from "./store/index.js";

/**
 * Prompt source interface — the plugin contract for system prompt assembly.
 *
 * Implementations can load prompts from files, database, remote config, etc.
 * The orchestrator depends on this interface, never on a concrete source.
 */
export interface PromptSource {
  assemble(store: AgentStore, profileId: string): Promise<string>;
}

const DEFAULT_BASE_PROMPT = `You are a personal AI assistant. You are helpful, concise, and direct.

You have access to tools — use them when they help answer the user's question.
If you don't know something and don't have a tool for it, say so honestly.`;

/**
 * Default prompt source: profile base prompt + steering rules + current time from DB.
 */
export class DefaultPromptSource implements PromptSource {
  #timezone: string;

  constructor(timezone = "UTC") {
    this.#timezone = timezone;
  }

  async assemble(store: AgentStore, profileId: string): Promise<string> {
    const profile = await store.getProfile(profileId);
    const basePrompt = profile?.basePrompt ?? DEFAULT_BASE_PROMPT;

    const rules = await store.getActiveRules(profileId);

    const parts = [basePrompt];

    if (rules.length > 0) {
      const rulesList = rules.map((r) => `- ${r.rule}`).join("\n");
      parts.push(`Rules:\n${rulesList}`);
    }

    parts.push(formatCurrentTime(this.#timezone));

    return parts.join("\n\n");
  }
}

function formatCurrentTime(timezone: string): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
  return `Current time: ${parts.weekday}, ${parts.month} ${parts.day}, ${parts.year}, ${parts.hour}:${parts.minute} (${timezone})`;
}
