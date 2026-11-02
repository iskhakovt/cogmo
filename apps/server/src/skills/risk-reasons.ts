/**
 * Why a deploy got its risk tier (design/skills.md → Risk tiers without a
 * human → Reasons): the one list for `classifier_log.reasons`, the deploy
 * notifications that show them and the `blocked` rejection. A deploy records
 * every reason that applies, not only the one that decided its tier.
 */
export const SKILL_RISK_REASONS = [
  "binding_unenforced",
  "egress_network_missing",
  "egress_listener_missing",
  "opted_in",
  "first_deploy",
  "manifest_widened",
  "wasm_unhardened",
  "container_unenforced",
  "container_shared_worker",
  "acting_effect",
  "unlisted_dependency",
  "sensitive_dependency",
  "paid_call",
  "raw_secret",
  "reads_and_egress",
  "no_review_panel",
  "container_tier",
  "approve_gating_effect",
  "secrets_with_network",
  "secret_breadth",
  "declared_effect",
  "network_declared",
  "classifier_fallback",
] as const;

export type SkillRiskReason = (typeof SKILL_RISK_REASONS)[number];
