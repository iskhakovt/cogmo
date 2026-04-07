import type { ToolDefinition } from "../llm/types.js";
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

// --- Prompt sections ---

const IDENTITY = `You are a personal AI assistant. You help one person — your user — with whatever they need: research, writing, planning, remembering, thinking through problems.

Be direct and genuine. Skip filler ("Great question!", "I'd be happy to help!"). If you can help, just help. If you can't, say so. Have opinions when asked — you're allowed to disagree, find things interesting or boring, recommend one option over another.

Be concise when the user wants a quick answer. Be thorough when the topic is complex or the user is exploring. Match their energy.`;

const ONBOARDING = `You don't know your user yet. In your first interaction, introduce yourself briefly and learn about them: their name, what they do, their timezone, and how they prefer to communicate. Store what you learn using memory_retain.`;

/** Service-level guidance — keyed by Service namespace. */
const SERVICE_GUIDANCE: Record<string, string> = {
  memory: `You have persistent memory across conversations. Use it well:
- **Recall first**: At the start of a conversation or when a topic comes up, check if you already know relevant context.
- **Retain important things**: Facts about the user, their preferences, decisions made, commitments, project context. Ask yourself: "would knowing this help me in a future conversation?"
- **Don't over-retain**: Skip greetings, small talk, information already saved in files, and things the user said are temporary.
- **Update, don't duplicate**: If you learn something that contradicts a previous memory, retain the new version with context about the change.`,

  files: `You have a persistent file workspace. Use it proactively — save meeting notes, draft emails, keep project summaries. Files persist across conversations.`,
};

export interface PromptSourceConfig {
  timezone?: string;
  getUserContext?: () => Promise<string | null>;
  toolDefinitions?: () => ToolDefinition[];
  activeServices?: string[];
}

/**
 * Default prompt source: identity + user context + tools (auto-generated)
 * + service guidance + steering rules + current time.
 *
 * Tool guidance is compiled from the tool registry — adding a tool
 * automatically updates the system prompt. Service guidance is keyed
 * by namespace — adding a Service namespace requires one guidance entry.
 */
export class DefaultPromptSource implements PromptSource {
  #timezone: string;
  #getUserContext: () => Promise<string | null>;
  #toolDefinitions: () => ToolDefinition[];
  #activeServices: string[];

  constructor(config: PromptSourceConfig = {}) {
    this.#timezone = config.timezone ?? "UTC";
    this.#getUserContext = config.getUserContext ?? (async () => null);
    this.#toolDefinitions = config.toolDefinitions ?? (() => []);
    this.#activeServices = config.activeServices ?? [];
  }

  async assemble(store: AgentStore, profileId: string): Promise<string> {
    const profile = await store.getProfile(profileId);
    const rules = await store.getActiveRules(profileId);
    const userContext = await this.#getUserContext();

    const parts: string[] = [];

    // Identity — always first
    parts.push(profile?.basePrompt ?? IDENTITY);

    // User context or onboarding
    if (userContext) {
      parts.push(`# User\n\n${userContext}`);
    } else {
      parts.push(`# User\n\n${ONBOARDING}`);
    }

    // Tools — auto-generated from registry
    const tools = this.#toolDefinitions();
    if (tools.length > 0) {
      const toolList = tools.map((t) => `- **${t.name}**: ${t.description}`).join("\n");
      parts.push(
        `# Tools\n\nYou have tools — use them proactively, don't wait to be asked.\n\n${toolList}`,
      );
    }

    // Service guidance — keyed by active namespaces
    const serviceGuidance = this.#activeServices.map((ns) => SERVICE_GUIDANCE[ns]).filter(Boolean);
    if (serviceGuidance.length > 0) {
      parts.push(`# Capabilities\n\n${serviceGuidance.join("\n\n")}`);
    }

    // Steering rules from DB
    if (rules.length > 0) {
      const rulesList = rules.map((r) => `- ${r.rule}`).join("\n");
      parts.push(`# Rules\n\n${rulesList}`);
    }

    // Current time
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
