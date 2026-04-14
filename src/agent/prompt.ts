import type { ToolDefinition } from "../llm/types.js";
import type { AgentStore } from "./store/index.js";

/**
 * Prompt source interface — the plugin contract for system prompt assembly.
 *
 * Implementations can load prompts from files, database, remote config, etc.
 * The orchestrator depends on this interface, never on a concrete source.
 */
export interface AssembleContext {
  profileId: string;
  channelTypes: string[];
}

export interface PromptSource {
  assemble(store: AgentStore, ctx: AssembleContext): Promise<string>;
}

// --- Prompt sections ---

const IDENTITY = `You are a personal AI assistant. You help one person — your user — with whatever they need: research, writing, planning, remembering, thinking through problems.

Be direct and genuine. Skip filler ("Great question!", "I'd be happy to help!"). If you can help, just help. If you can't, say so. Have opinions when asked — you're allowed to disagree, find things interesting or boring, recommend one option over another.

Be concise when the user wants a quick answer. Be thorough when the topic is complex or the user is exploring. Match their energy.`;

const ONBOARDING = `You don't know your user yet. In your first interaction, introduce yourself briefly and learn about them: their name, what they do, their timezone, and how they prefer to communicate. Store what you learn using memory_retain.`;

export interface PromptSourceConfig {
  timezone?: string;
  getUserContext?: () => Promise<string | null>;
  toolDefinitions?: () => ToolDefinition[];
  serviceGuidance?: string[];
}

/**
 * Default prompt source: identity + user context + tools (auto-generated)
 * + service guidance + steering rules + current time.
 *
 * Tool guidance is compiled from the tool registry — adding a tool
 * automatically updates the system prompt. Service guidance is provided
 * by each namespace implementation — adding a namespace means exporting
 * a guidance string from the implementation file.
 */
export class DefaultPromptSource implements PromptSource {
  #timezone: string;
  #getUserContext: () => Promise<string | null>;
  #toolDefinitions: () => ToolDefinition[];
  #serviceGuidance: string[];

  constructor(config: PromptSourceConfig = {}) {
    this.#timezone = config.timezone ?? "UTC";
    this.#getUserContext = config.getUserContext ?? (async () => null);
    this.#toolDefinitions = config.toolDefinitions ?? (() => []);
    this.#serviceGuidance = config.serviceGuidance ?? [];
  }

  async assemble(store: AgentStore, ctx: AssembleContext): Promise<string> {
    const { profileId, channelTypes } = ctx;
    const profile = await store.getProfile(profileId);
    const rules = await store.getActiveRules(profileId, channelTypes);
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

    // Service guidance — provided by each namespace implementation
    if (this.#serviceGuidance.length > 0) {
      parts.push(`# Capabilities\n\n${this.#serviceGuidance.join("\n\n")}`);
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
