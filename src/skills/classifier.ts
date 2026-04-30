import type { ClassifierLog, SkillManifest } from "./types.js";

/**
 * P3.3 first-slice classifier — deterministic, declaration-only. Pins every
 * skill to `notify` so the agent can register skills without an approval gate
 * while the AST-lint upgrade lands in a follow-up. The shape is the same the
 * full classifier will use; only `risk_tier` selection and `detected_effects`
 * change later.
 *
 * Why pin to `notify`, not `auto`:
 * - `auto` is reserved for skills that are provably read-only-and-no-secrets
 *   per design (`design/skills.md` → Risk tiering). Without static analysis
 *   we can't prove that — declaring `effects: []` doesn't mean the body
 *   doesn't reach the network.
 * - `notify` keeps every register on `main` immediately (no approval block)
 *   while still emitting a one-line "added skill X" notification, giving
 *   the user a chance to `/disable X` if it shows up unexpectedly.
 *
 * Replace `classifier_version` when the AST-lint pass ships so old deploy
 * rows can be re-classified or distinguished in the audit log.
 */
export const STUB_CLASSIFIER_VERSION = "stub-1-notify-pinned";

export function classifyManifest(manifest: SkillManifest): ClassifierLog {
  const declaredSecrets = manifest.secrets.map((s) => (typeof s === "string" ? s : s.name));
  return {
    classifier_version: STUB_CLASSIFIER_VERSION,
    risk_tier: "notify",
    declared_effects: manifest.effects,
    detected_effects: [],
    declared_secrets: declaredSecrets,
    validation_errors: [],
  };
}
