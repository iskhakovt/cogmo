import { logger } from "../logger.js";
import { AST_CLASSIFIER_VERSION, classifyWithAst } from "./ast-classifier.js";
import {
  APPROVE_GATING_EFFECTS,
  APPROVE_SECRETS_THRESHOLD,
  categoriseDependency,
} from "./ast-rules.js";
import type { ClassifierLog, SkillManifest } from "./types.js";

/**
 * Skills risk classifier. Two paths:
 *
 *   - **Primary** — `classifyWithAst(manifest, body)` walks the
 *     Python source via tree-sitter, detects undeclared effects, and
 *     promotes/rejects based on what the body actually does. See
 *     `ast-classifier.ts` for the threat model and rule mechanics.
 *
 *   - **Fallback** — declaration-only stub that consults
 *     `manifest.effects` / `tier` / `secrets` count, no AST involved.
 *     Fires when the AST path throws (parser load failure, walk
 *     panic, missing wasm at runtime). Surfaces a structured log line
 *     with `event: classifier_fallback` so an operator can spot the
 *     degradation; the deploy still completes with the conservative
 *     stub tier.
 *
 * Public entry is `classifyManifest(manifest, body)` — async because
 * the AST parser load is async. Tests that don't exercise body AST
 * may pass an empty body; the AST path will run, find nothing, and
 * return the same tier the declaration-only path would.
 */

const log = logger.child({ component: "skills.classifier" });

/**
 * Stub classifier version. Used by the fallback path only. The AST
 * path stamps `AST_CLASSIFIER_VERSION` (`ast-1`) so audit-log
 * consumers can tell the two apart.
 */
export const STUB_CLASSIFIER_VERSION = "stub-2-effect-aware";

/**
 * Re-exported so `register` / `__registerForTests` (and any other
 * non-AST writers of `classifier_log`) can stamp a known constant
 * without depending on the AST module.
 */
export { AST_CLASSIFIER_VERSION };

export async function classifyManifest(
  manifest: SkillManifest,
  body: string,
): Promise<ClassifierLog> {
  try {
    return await classifyWithAst(manifest, body);
  } catch (err) {
    log.warn(
      { event: "classifier_fallback", err, skillName: manifest.name },
      "ast classifier threw; falling back to declaration-only stub",
    );
    return classifyManifestStub(manifest);
  }
}

/**
 * Declaration-only fallback. Same shape as the AST path's output but
 * with `classifier_version: STUB_CLASSIFIER_VERSION` and
 * `detected_effects: []`. Auto-tier is unreachable here on purpose —
 * the stub can't *prove* a skill is read-only, only the AST path can.
 *
 * Exported for tests that want to exercise the fallback explicitly.
 */
export function classifyManifestStub(manifest: SkillManifest): ClassifierLog {
  const declaredSecrets = manifest.secrets.map((s) => (typeof s === "string" ? s : s.name));

  const hasApproveEffect = manifest.effects.some((e) => APPROVE_GATING_EFFECTS.has(e));
  const isContainerTier = manifest.tier === "container";
  const hasManySecrets = declaredSecrets.length >= APPROVE_SECRETS_THRESHOLD;
  const hasApproveDep = manifest.dependencies.some((d) => categoriseDependency(d) === "approve");

  // Stub can't reach `auto` (only the AST path can prove a body is
  // read-only), so the dep-allowlist case still lands at `notify` here —
  // see classifier.ts header. Approve-tier deps still force `approve`.
  const riskTier =
    hasApproveEffect || isContainerTier || hasManySecrets || hasApproveDep ? "approve" : "notify";

  return {
    classifier_version: STUB_CLASSIFIER_VERSION,
    risk_tier: riskTier,
    declared_effects: manifest.effects,
    detected_effects: [],
    declared_secrets: declaredSecrets,
    declared_dependencies: manifest.dependencies,
    validation_errors: [],
  };
}
