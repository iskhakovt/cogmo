import type { ToolDefinition } from "../llm/types.js";
import type { CoreMemoryView } from "./core-memory/scope.js";
import { RULE_SECTIONS, type RuleSection, type SectionedRule } from "./rule-sections.js";
import type { CoreMemoryBlock } from "./service.js";
import type { Profile } from "./store/index.js";
import { TURN_CONTEXT_GUIDANCE } from "./turn-context.js";

/**
 * Prompt source interface — the plugin contract for system prompt
 * assembly. Pure formatter: takes pre-loaded data and renders the
 * prompt. Loading happens upstream, typically via `loadConversationContext`.
 */
export interface AssembleContext {
  profile: Profile | undefined;
  /** Active steering rules, rendered by section in the given order within each. */
  rules: ReadonlyArray<SectionedRule>;
  /**
   * The conversation user's core memory as the turn's scope sees it — the
   * blocks `core_memory_update` writes — rendered as the `# User` section.
   * No visible block shows the onboarding text instead, and a turn without
   * core memory has no `# User` section.
   */
  coreMemory: CoreMemoryView;
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

const ONBOARDING = `You don't know your user yet. In your first interaction, introduce yourself briefly and learn about them: their name, what they do, their timezone, and how they prefer to communicate. Save what you learn about them, including anything about them they mention in passing, to core memory with core_memory_update as soon as you learn it, without waiting to learn the rest: a block can start with one line.`;

/** Leads a classed profile's shared group. */
const SHARED_GROUP = "Shared by every persona:";

/** Leads a restricted class's shared group, where the persona's own `identity` wins. */
const RESTRICTED_SHARED_GROUP =
  "Shared by every persona. This persona's own `identity`, if it has one, wins where the two " +
  "differ, and the lines it leaves out still come from here. An `identity` you save here " +
  "becomes that one and stays in this persona, so write only the lines that differ from this " +
  "block, not a copy of it:";

/** Leads a classed profile's own group. */
const OWN_GROUP = "Only in this persona:";

const RULES_PREAMBLE =
  "Standing rules for your replies. Where two rules that apply to this reply conflict, follow the one listed first.";

const RULE_SECTION_HEADINGS: Readonly<Record<RuleSection, string>> = {
  always: "## Always",
  from_user:
    "## From your user\nYour user asked for these. They take precedence over your default style and the channel defaults.",
  learned: "## Learned from your user",
  channel_defaults: "## Channel defaults",
};

export interface PromptSourceConfig {
  serviceGuidance?: ReadonlyArray<string>;
}

/**
 * The `# User` section body for what a turn sees of core memory, or null when
 * it sees no block. An unclassed profile's blocks render flat; a classed
 * profile's render as the shared group, then its own, each block headed by
 * its bare key.
 */
export function formatUserContext(view: CoreMemoryView): string | null {
  const { scope, blocks } = view;
  if (blocks.length === 0) return null;
  if (scope.kind !== "classed") return formatBlocks(blocks);
  const shared = blocks.filter((b) => b.profileClass === null);
  const own = blocks.filter((b) => b.profileClass !== null);
  const groups: Array<[string, ReadonlyArray<CoreMemoryBlock>]> = [
    [scope.restricted ? RESTRICTED_SHARED_GROUP : SHARED_GROUP, shared],
    [OWN_GROUP, own],
  ];
  return groups
    .filter(([, group]) => group.length > 0)
    .map(([lead, group]) => `${lead}\n\n${formatBlocks(group)}`)
    .join("\n\n");
}

function formatBlocks(blocks: ReadonlyArray<CoreMemoryBlock>): string {
  return blocks.map((b) => `## ${b.key}\n${b.content}`).join("\n\n");
}

/** The `# Rules` section body: a subsection per non-empty section, in precedence order. */
function formatRules(rules: ReadonlyArray<SectionedRule>): string {
  const sections = RULE_SECTIONS.flatMap((section) => {
    const lines = rules.filter((r) => r.section === section).map((r) => `- ${r.rule}`);
    return lines.length > 0 ? [`${RULE_SECTION_HEADINGS[section]}\n${lines.join("\n")}`] : [];
  });
  return [RULES_PREAMBLE, ...sections].join("\n\n");
}

/**
 * Default prompt source: identity + user context + tools (auto-generated)
 * + service guidance + steering rules + how to read the turn context.
 *
 * Nothing per-turn renders here: the time, recalled memories and reply
 * modality lead each turn's user message (`turn-context.ts`), so the prompt
 * changes only when its configuration or core memory does.
 *
 * The `# Tools` section is rendered from the per-turn `toolDefinitions`
 * supplied via `AssembleContext` — the orchestrator passes the same catalog
 * it advertises to the LLM API, so built-ins, image, skill, and MCP tools
 * are all introspectable by the model. Service guidance is provided by each
 * namespace implementation — adding a namespace means exporting a guidance
 * string from the implementation file.
 */
export class DefaultPromptSource implements PromptSource {
  #serviceGuidance: ReadonlyArray<string>;

  constructor(config: PromptSourceConfig = {}) {
    this.#serviceGuidance = config.serviceGuidance ?? [];
  }

  async assemble(ctx: AssembleContext): Promise<string> {
    const { profile, rules, coreMemory, toolDefinitions } = ctx;

    const parts: string[] = [];

    // Identity — always first
    parts.push(profile?.basePrompt ?? IDENTITY);

    // User context or onboarding, unless the turn has no core memory
    if (coreMemory.scope.kind !== "none") {
      parts.push(`# User\n\n${formatUserContext(coreMemory) ?? ONBOARDING}`);
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
      parts.push(`# Rules\n\n${formatRules(rules)}`);
    }

    // Last, so its voice guidance isn't drowned out by the identity and
    // tools sections.
    parts.push(TURN_CONTEXT_GUIDANCE);

    return parts.join("\n\n");
  }
}
