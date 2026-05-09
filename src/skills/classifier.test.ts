import { describe, expect, it } from "vitest";
import {
  AST_CLASSIFIER_VERSION,
  classifyManifest,
  classifyManifestStub,
  STUB_CLASSIFIER_VERSION,
} from "./classifier.js";
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

const NOOP_BODY = `
async def run(inputs, ctx):
    return {"ok": True}
`;

/**
 * Live path — the AST classifier on top of the stub. Tests here run
 * the real tree-sitter parse against small fixture bodies; behaviours
 * specific to AST detection (undeclared-effect rejection, auto
 * promotion) are pinned in `ast-classifier.test.ts`.
 */
describe("classifyManifest (live AST path)", () => {
  it("stamps the AST classifier version when AST runs successfully", async () => {
    const log = await classifyManifest(makeManifest(), NOOP_BODY);
    expect(log.classifier_version).toBe(AST_CLASSIFIER_VERSION);
  });

  it("promotes empty-effects + harmless body to auto (the unlock)", async () => {
    const log = await classifyManifest(makeManifest(), NOOP_BODY);
    expect(log.risk_tier).toBe("auto");
  });

  it("non-trivial declared effect at wasm tier stays notify", async () => {
    const log = await classifyManifest(
      makeManifest({ tier: "wasm", effects: ["reads_memory"] }),
      NOOP_BODY,
    );
    expect(log.risk_tier).toBe("notify");
  });

  it("container tier still forces approve regardless of body", async () => {
    const log = await classifyManifest(makeManifest({ tier: "container" }), NOOP_BODY);
    expect(log.risk_tier).toBe("approve");
  });
});

/**
 * Fallback path — declaration-only stub used when the AST parser load
 * or walk throws. Identical to the pre-AST classifier, kept for
 * audit-log compatibility and exercised explicitly here so a
 * regression in stub behaviour shows up at this test file (where
 * it's most readable) rather than via the AST tests.
 */
describe("classifyManifestStub (fallback)", () => {
  it("stamps the stub classifier version", () => {
    const log = classifyManifestStub(makeManifest());
    expect(log.classifier_version).toBe(STUB_CLASSIFIER_VERSION);
  });

  it("defaults harmless wasm-tier skills to notify", () => {
    const log = classifyManifestStub(
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
    "writes_filesystem",
  ])("promotes %s to approve tier", (effect) => {
    const log = classifyManifestStub(makeManifest({ effects: [effect] }));
    expect(log.risk_tier).toBe("approve");
  });

  it("does NOT promote benign effects (reads_memory, writes_memory) to approve", () => {
    const log = classifyManifestStub(
      makeManifest({ effects: ["reads_memory", "writes_memory", "reads_user_data"] }),
    );
    expect(log.risk_tier).toBe("notify");
  });

  it("promotes container-tier skills to approve regardless of effects", () => {
    const log = classifyManifestStub(makeManifest({ tier: "container" }));
    expect(log.risk_tier).toBe("approve");
  });

  it("promotes 3+ secrets to approve (broad permissions)", () => {
    const log = classifyManifestStub(makeManifest({ secrets: ["a", "b", "c"] }));
    expect(log.risk_tier).toBe("approve");
  });

  it("keeps 2 secrets at notify (under threshold)", () => {
    const log = classifyManifestStub(makeManifest({ secrets: ["a", "b"] }));
    expect(log.risk_tier).toBe("notify");
  });

  it("auto tier is unreachable in the stub", () => {
    const log = classifyManifestStub(makeManifest());
    expect(log.risk_tier).not.toBe("auto");
  });

  it("records declared secrets by name", () => {
    const log = classifyManifestStub(
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
