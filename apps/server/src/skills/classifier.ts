import { match } from "ts-pattern";
import { logger } from "../logger.js";
import {
  AST_CLASSIFIER_VERSION,
  classifyWithAstForRollback,
  computeRiskTier,
} from "./ast-classifier.js";
import type { SkillsCapabilities } from "./capabilities.js";
import type { ClassifierLog, SkillManifest } from "./types.js";

/**
 * Rollback's risk classifier. Two paths:
 *
 *   - **Primary** — `classifyWithAstForRollback` walks the Python source
 *     via tree-sitter, detects undeclared effects, and promotes/rejects
 *     based on what the body actually does; an effect only a ctx row
 *     detected counts in the tier and rejects nothing. See
 *     `ast-classifier.ts` for the threat model and rule mechanics.
 *
 *   - **Fallback** — declaration-only stub that consults
 *     `manifest.effects` / `tier` / `secrets` count, no AST involved.
 *     Fires when the AST path throws (parser load failure, walk
 *     panic, missing wasm at runtime). Surfaces a structured log line
 *     with `event: classifier_fallback` so an operator can spot the
 *     degradation; the rollback still completes with the conservative
 *     stub tier.
 *
 * Register calls `classifyWithAst` directly and never takes the stub: it
 * deploys no body the AST path did not read (design/skills.md →
 * Register-time gates).
 */

const log = logger.child({ component: "skills.classifier" });

/**
 * Stub classifier version. Used by the fallback path only. The AST
 * path stamps `AST_CLASSIFIER_VERSION` so audit-log consumers can tell
 * the two apart.
 */
export const STUB_CLASSIFIER_VERSION = "stub-3-reasons";

/**
 * Re-exported so `register` / `__registerForTests` (and any other
 * non-AST writers of `classifier_log`) can stamp a known constant
 * without depending on the AST module.
 */
export { AST_CLASSIFIER_VERSION };

export async function classifyManifest(
  manifest: SkillManifest,
  body: string,
  capabilities: SkillsCapabilities,
): Promise<ClassifierLog> {
  try {
    return await classifyWithAstForRollback(manifest, body, capabilities);
  } catch (err) {
    log.warn(
      { event: "classifier_fallback", err, skillName: manifest.name },
      "ast classifier threw; falling back to declaration-only stub",
    );
    return classifyManifestStub(manifest, capabilities);
  }
}

/**
 * Declaration-only fallback. Same shape as the AST path's output but
 * with `classifier_version: STUB_CLASSIFIER_VERSION` and
 * `detected_effects: []`. It runs the AST path's table over the
 * declarations alone, so the two agree on every `approve` trigger —
 * secrets alongside network included, since `notify` deploys live and a
 * degraded classifier must not ship the combination the stricter path
 * refuses. Auto-tier is unreachable here on purpose: the stub can't
 * *prove* a skill is read-only, only the AST path can, so a table
 * result of `auto` lands at `notify`.
 *
 * Exported for tests that want to exercise the fallback explicitly.
 */
export function classifyManifestStub(
  manifest: SkillManifest,
  capabilities: SkillsCapabilities,
): ClassifierLog {
  const declaredSecrets = manifest.secrets.map((s) => (typeof s === "string" ? s : s.name));

  const { riskTier, reasons } = computeRiskTier({
    declared: manifest.effects,
    detected: [],
    validationErrors: [],
    tier: manifest.tier,
    secretsCount: declaredSecrets.length,
    hasNetwork: manifest.network !== undefined,
    dependencies: manifest.dependencies,
    capabilities,
  });

  // The stub cannot show a body read-only, so `auto` is out of its reach;
  // the cap is recorded as a reason of its own.
  const stubbed = match(riskTier)
    .returnType<Pick<ClassifierLog, "risk_tier" | "reasons">>()
    .with("auto", () => ({ risk_tier: "notify", reasons: [...reasons, "classifier_fallback"] }))
    .with("notify", "approve", (tier) => ({ risk_tier: tier, reasons }))
    .exhaustive();
  return {
    classifier_version: STUB_CLASSIFIER_VERSION,
    risk_tier: stubbed.risk_tier,
    declared_effects: manifest.effects,
    detected_effects: [],
    declared_secrets: declaredSecrets,
    declared_dependencies: manifest.dependencies,
    validation_errors: [],
    reasons: stubbed.reasons,
    declared_network: manifest.network?.allow ?? null,
    capabilities: { ...capabilities },
    toolchain_version: null,
  };
}
