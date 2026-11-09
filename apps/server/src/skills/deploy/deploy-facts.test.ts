import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { SkillDeployRow } from "../store/index.js";
import { type ClassifierLog, SkillManifestSchema } from "../types.js";
import { deployFacts } from "./deploy-facts.js";

const BASE_MANIFEST = {
  name: "briefing",
  description: "Posts the morning briefing.",
  tier: "container",
  inputs: { type: "object" },
};

function classifierLog(overrides: Partial<ClassifierLog> = {}): ClassifierLog {
  return {
    classifier_version: "test",
    risk_tier: "approve",
    declared_effects: [],
    detected_effects: [],
    declared_secrets: [],
    declared_dependencies: [],
    validation_errors: [],
    reasons: [],
    declared_network: null,
    toolchain_version: null,
    ...overrides,
  };
}

function deployRow(log: ClassifierLog, priorGitSha: string | null): SkillDeployRow {
  return { ...mock<SkillDeployRow>(), classifierLog: log, priorGitSha };
}

describe("deployFacts", () => {
  it("reads every fact from the manifest and the deploy's classifier log", () => {
    const manifest = SkillManifestSchema.parse({
      ...BASE_MANIFEST,
      triggers: ["manual", "cron"],
      schedule: "0 9 * * *",
      effects: ["sends_message"],
      secrets: ["legacy_token", { name: "api_key", binding: { destination: "api.example.com" } }],
      dependencies: ["httpx==0.27.0"],
      network: { allow: ["api.example.com", "*.cdn.example.com"] },
    });
    const log = classifierLog({
      declared_effects: ["sends_message"],
      detected_effects: ["reads_memory"],
      reasons: ["container_tier", "secrets_with_network"],
    });

    expect(deployFacts(manifest, deployRow(log, "abc1234"))).toEqual({
      description: "Posts the morning briefing.",
      effects: { declared: ["sends_message"], detected: ["reads_memory"] },
      hosts: ["api.example.com", "*.cdn.example.com"],
      secrets: [
        { name: "legacy_token", bound: false },
        { name: "api_key", bound: true },
      ],
      dependencies: ["httpx==0.27.0"],
      schedule: "0 9 * * *",
      reasons: ["container_tier", "secrets_with_network"],
      priorGitSha: "abc1234",
    });
  });

  it("an object-form secret without a binding is raw", () => {
    const manifest = SkillManifestSchema.parse({ ...BASE_MANIFEST, secrets: [{ name: "token" }] });

    expect(deployFacts(manifest, deployRow(classifierLog(), null)).secrets).toEqual([
      { name: "token", bound: false },
    ]);
  });

  it("a manifest with no network block, schedule or prior version", () => {
    const manifest = SkillManifestSchema.parse(BASE_MANIFEST);

    expect(deployFacts(manifest, deployRow(classifierLog(), null))).toMatchObject({
      hosts: [],
      schedule: null,
      priorGitSha: null,
    });
  });

  it("returns copies, not the classifier log's arrays", () => {
    const log = classifierLog({ declared_effects: ["sends_message"], reasons: ["container_tier"] });
    const facts = deployFacts(SkillManifestSchema.parse(BASE_MANIFEST), deployRow(log, null));

    expect(facts.effects.declared).not.toBe(log.declared_effects);
    expect(facts.reasons).not.toBe(log.reasons);
  });
});
