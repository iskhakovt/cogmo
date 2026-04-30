import type { ClassifierLog, SkillEffect, SkillManifest } from "./types.js";

/**
 * P3.3 first-slice classifier — deterministic, declaration-only. The full
 * version with AST-lint detection of undeclared effects (`subprocess`,
 * `os.remove`, destructive SDK methods) lands in a follow-up; this version
 * trusts what the manifest declares and routes accordingly.
 *
 * Tier assignment based on declared fields (`design/skills.md` → Risk tiering):
 *
 * - **`approve`** when the manifest declares any destructive / external /
 *   financial effect, OR when `tier: container` (sysbox isolation isn't a
 *   substitute for human review of side effects), OR when the skill declares
 *   3+ secrets (broad permissions). These need explicit user signoff via the
 *   Telegram approval flow before main is advanced.
 * - **`notify`** for everything else. Keeps fast iteration on harmless skills
 *   while a one-line "added skill X" notification lets the user `/disable X`
 *   if it shows up unexpectedly.
 * - **`auto`** is intentionally unreachable until static analysis can *prove*
 *   a skill is read-only with no network reach. Declaring `effects: []`
 *   doesn't prove the body doesn't `httpx.post(...)`. Reserved for the
 *   AST-lint slice.
 *
 * `classifier_version` is bumped here so old deploy rows in `skill_deploys`
 * can be distinguished from rows the AST-lint version writes.
 */
export const STUB_CLASSIFIER_VERSION = "stub-2-effect-aware";

/**
 * Effects that force the `approve` tier. Mirrors `design/skills.md`'s
 * destructive / external-messaging / financial / host-mutation set. Anything
 * in this set means a misbehaving skill could send messages, delete external
 * resources, move money, write to the host filesystem, or shell out —
 * outcomes the user wants to gate explicitly.
 */
const APPROVE_GATING_EFFECTS: ReadonlySet<SkillEffect> = new Set<SkillEffect>([
  "deletes_external",
  "sends_email",
  "sends_message",
  "posts_public",
  "financial",
  "spawns_subprocess",
  "writes_filesystem",
]);

const APPROVE_SECRETS_THRESHOLD = 3;

export function classifyManifest(manifest: SkillManifest): ClassifierLog {
  const declaredSecrets = manifest.secrets.map((s) => (typeof s === "string" ? s : s.name));

  const hasApproveEffect = manifest.effects.some((e) => APPROVE_GATING_EFFECTS.has(e));
  const isContainerTier = manifest.tier === "container";
  const hasManySecrets = declaredSecrets.length >= APPROVE_SECRETS_THRESHOLD;

  const riskTier = hasApproveEffect || isContainerTier || hasManySecrets ? "approve" : "notify";

  return {
    classifier_version: STUB_CLASSIFIER_VERSION,
    risk_tier: riskTier,
    declared_effects: manifest.effects,
    detected_effects: [],
    declared_secrets: declaredSecrets,
    validation_errors: [],
  };
}
