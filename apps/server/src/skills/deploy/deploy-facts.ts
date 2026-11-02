import type { SkillRiskReason } from "../risk-reasons.js";
import type { SkillDeployRow } from "../store/index.js";
import type { SkillEffect, SkillManifest } from "../types.js";

/**
 * What a deploy outcome tells the user about the version it concerns
 * (design/skills.md → Notifications and undo): what the manifest declares,
 * what the classifier detected, and why it got its tier.
 */
export interface DeployFacts {
  description: string;
  effects: { declared: readonly SkillEffect[]; detected: readonly SkillEffect[] };
  /** The manifest's `network.allow`; empty without a `network:` block. */
  hosts: readonly string[];
  /** Each declared secret, and whether it carries a destination binding. */
  secrets: readonly { name: string; bound: boolean }[];
  dependencies: readonly string[];
  schedule: string | null;
  reasons: readonly SkillRiskReason[];
  /** The version the deploy replaces; null on a skill's first deploy. */
  priorGitSha: string | null;
}

/** The facts of `deploy`, whose version `manifest` is the manifest of. */
export function deployFacts(manifest: SkillManifest, deploy: SkillDeployRow): DeployFacts {
  const log = deploy.classifierLog;
  return {
    description: manifest.description,
    effects: { declared: [...log.declared_effects], detected: [...log.detected_effects] },
    hosts: [...(manifest.network?.allow ?? [])],
    secrets: manifest.secrets.map((secret) =>
      typeof secret === "string"
        ? { name: secret, bound: false }
        : { name: secret.name, bound: secret.binding !== undefined },
    ),
    dependencies: [...manifest.dependencies],
    schedule: manifest.schedule ?? null,
    reasons: [...log.reasons],
    priorGitSha: deploy.priorGitSha,
  };
}
