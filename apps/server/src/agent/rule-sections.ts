import type { SteeringRuleSourceValue } from "./store/schema.js";

/**
 * The sections `# Rules` renders, in precedence order: where two rules that
 * apply to a reply conflict, the one in the earlier section wins
 * (design/evolution.md → Explicit Instructions → Precedence).
 */
export const RULE_SECTIONS = ["always", "from_user", "learned", "channel_defaults"] as const;

export type RuleSection = (typeof RULE_SECTIONS)[number];

const SECTION_OF_SOURCE: Readonly<Record<SteeringRuleSourceValue, RuleSection>> = {
  manual: "always",
  instruction: "from_user",
  correction: "learned",
  evolution: "learned",
  seed: "channel_defaults",
};

export function ruleSection(source: SteeringRuleSourceValue): RuleSection {
  return SECTION_OF_SOURCE[source];
}

/** An active steering rule, the `# Rules` section it renders in, and its channel (null: every channel). */
export interface SectionedRule {
  rule: string;
  section: RuleSection;
  channelType: string | null;
}
