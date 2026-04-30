import { describe, expect, it } from "vitest";
import { classifyManifest, STUB_CLASSIFIER_VERSION } from "./classifier.js";
import type { SkillEffect, SkillManifest } from "./types.js";

function makeManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: "test",
    description: "a test skill that exists for classifier tests",
    tier: "wasm",
    triggers: ["manual"],
    inputs: { type: "object", properties: {} },
    effects: [],
    secrets: [],
    cost_per_call_usd: 0,
    ...overrides,
  } as SkillManifest;
}

describe("classifyManifest", () => {
  it("stamps the current classifier version", () => {
    const log = classifyManifest(makeManifest());
    expect(log.classifier_version).toBe(STUB_CLASSIFIER_VERSION);
  });

  it("defaults harmless wasm-tier skills to notify", () => {
    const log = classifyManifest(
      makeManifest({ tier: "wasm", effects: ["reads_memory"], secrets: [] }),
    );
    expect(log.risk_tier).toBe("notify");
  });

  it.each<SkillEffect>([
    "deletes_external",
    "sends_email",
    "sends_message",
    "posts_public",
    "financial",
    "spawns_subprocess",
  ])("promotes %s to approve tier", (effect) => {
    const log = classifyManifest(makeManifest({ effects: [effect] }));
    expect(log.risk_tier).toBe("approve");
  });

  it("does NOT promote benign effects (reads_memory, writes_memory) to approve", () => {
    const log = classifyManifest(
      makeManifest({ effects: ["reads_memory", "writes_memory", "reads_user_data"] }),
    );
    expect(log.risk_tier).toBe("notify");
  });

  it("promotes container-tier skills to approve regardless of effects", () => {
    const log = classifyManifest(makeManifest({ tier: "container" }));
    expect(log.risk_tier).toBe("approve");
  });

  it("promotes 3+ secrets to approve (broad permissions)", () => {
    const log = classifyManifest(makeManifest({ secrets: ["a", "b", "c"] }));
    expect(log.risk_tier).toBe("approve");
  });

  it("keeps 2 secrets at notify (under threshold)", () => {
    const log = classifyManifest(makeManifest({ secrets: ["a", "b"] }));
    expect(log.risk_tier).toBe("notify");
  });

  it("auto tier is unreachable in this stub (reserved for AST-lint slice)", () => {
    // Try every plausible no-secrets, no-effects, wasm combination — none
    // should produce auto. AST-lint needed before we can prove a body is
    // genuinely read-only with no network reach.
    const log = classifyManifest(makeManifest());
    expect(log.risk_tier).not.toBe("auto");
  });

  it("records declared secrets by name", () => {
    const log = classifyManifest(
      makeManifest({
        secrets: [
          "plain_name",
          { name: "object_form", binding: { destination: "https://x", substitute: "url" } },
        ],
      }),
    );
    expect(log.declared_secrets).toEqual(["plain_name", "object_form"]);
  });
});
