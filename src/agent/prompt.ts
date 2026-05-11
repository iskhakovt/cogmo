import type { ToolDefinition } from "../llm/types.js";
import type { Profile } from "./store/index.js";

/**
 * Prompt source interface — the plugin contract for system prompt
 * assembly. Pure formatter: takes pre-loaded data and renders the
 * prompt. Loading happens upstream, typically via `loadConversationContext`.
 */
export interface AssembleContext {
  profile: Profile | undefined;
  rules: ReadonlyArray<{ rule: string }>;
  /**
   * True when the orchestrator has resolved this turn's reply will be TTS'd
   * to a voice clip. Drives a voice-style hint appended to the system
   * prompt so Claude shapes its response for speech (short sentences, no
   * markdown, no narration of background ops). See design/voice.md →
   * "Prompt injection".
   */
  voiceMode?: boolean;
  /**
   * Per-turn tool catalog rendered into the `# Tools` section. Passed in by
   * the orchestrator after `composeTurnTools` resolves built-ins + image +
   * skill + MCP tools against the profile's globs, so the prompt reflects
   * exactly what the API call advertises this turn. Omit (or pass an empty
   * array) to suppress the section.
   */
  toolDefinitions?: ReadonlyArray<ToolDefinition>;
}

export interface PromptSource {
  assemble(ctx: AssembleContext): Promise<string>;
}

// --- Prompt sections ---

const IDENTITY = `You are a personal AI assistant. You help one person — your user — with whatever they need: research, writing, planning, remembering, thinking through problems.

Be direct and genuine. Skip filler ("Great question!", "I'd be happy to help!"). If you can help, just help. If you can't, say so. Have opinions when asked — you're allowed to disagree, find things interesting or boring, recommend one option over another.

Be concise when the user wants a quick answer. Be thorough when the topic is complex or the user is exploring. Match their energy.`;

const ONBOARDING = `You don't know your user yet. In your first interaction, introduce yourself briefly and learn about them: their name, what they do, their timezone, and how they prefer to communicate. Store what you learn using memory_retain.`;

const VOICE_MODE_HINT = `# Voice mode

Your response will be spoken aloud. Keep it short and natural — one or two sentences when possible. Skip routine acknowledgments ("saved", "noted", "I'll remember") unless the acknowledgment IS the entire answer. Don't narrate background work (memory saves, file writes, web searches) — the user assumes those happened. Avoid markdown, lists, code fences, and tables — they don't translate to speech.`;

export interface PromptSourceConfig {
  timezone?: string;
  getUserContext?: () => Promise<string | null>;
  serviceGuidance?: string[];
}

/**
 * Default prompt source: identity + user context + tools (auto-generated)
 * + service guidance + steering rules + current time.
 *
 * The `# Tools` section is rendered from the per-turn `toolDefinitions`
 * supplied via `AssembleContext` — the orchestrator passes the same catalog
 * it advertises to the LLM API, so built-ins, image, skill, and MCP tools
 * are all introspectable by the model. Service guidance is provided by each
 * namespace implementation — adding a namespace means exporting a guidance
 * string from the implementation file.
 */
export class DefaultPromptSource implements PromptSource {
  #timezone: string;
  #getUserContext: () => Promise<string | null>;
  #serviceGuidance: string[];

  constructor(config: PromptSourceConfig = {}) {
    this.#timezone = config.timezone ?? "UTC";
    this.#getUserContext = config.getUserContext ?? (async () => null);
    this.#serviceGuidance = config.serviceGuidance ?? [];
  }

  async assemble(ctx: AssembleContext): Promise<string> {
    const { profile, rules, voiceMode, toolDefinitions } = ctx;
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

    // Tools — rendered from the per-turn catalog
    const tools = toolDefinitions ?? [];
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

    // Voice-mode hint — placed near the end so it isn't drowned out by
    // earlier identity/tools sections. Shapes the LLM's response style for
    // TTS even though delivery happens out-of-band post-stream.
    if (voiceMode) {
      parts.push(VOICE_MODE_HINT);
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
