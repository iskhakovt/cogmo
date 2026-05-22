import { describe, expect, it } from "vitest";
import {
  ClassifierLogSchema,
  SKILL_EFFECTS,
  SkillEffectsSchema,
  SkillIoSchema,
  SkillManifestSchema,
} from "./types.js";

const MIN_MANIFEST = {
  name: "valid-name",
  description: "a description longer than ten chars",
  tier: "wasm" as const,
  inputs: { type: "object", properties: {} },
};

describe("SkillEffectsSchema", () => {
  it.each(SKILL_EFFECTS)("accepts the %s effect", (effect) => {
    expect(SkillEffectsSchema.parse([effect])).toEqual([effect]);
  });

  it("accepts empty array", () => {
    expect(SkillEffectsSchema.parse([])).toEqual([]);
  });

  it("accepts multiple effects", () => {
    const r = SkillEffectsSchema.parse(["reads_memory", "writes_memory"]);
    expect(r).toEqual(["reads_memory", "writes_memory"]);
  });

  it("rejects unknown effect strings", () => {
    expect(() => SkillEffectsSchema.parse(["not_an_effect"])).toThrow();
  });

  it("rejects non-array", () => {
    expect(() => SkillEffectsSchema.parse("reads_memory")).toThrow();
    expect(() => SkillEffectsSchema.parse(null)).toThrow();
    expect(() => SkillEffectsSchema.parse({ effects: ["reads_memory"] })).toThrow();
  });

  it("accepts duplicates (no de-dup)", () => {
    // Documented behavior — Zod doesn't dedupe arrays. If we ever want to,
    // this test pins the current contract so the change is intentional.
    const r = SkillEffectsSchema.parse(["reads_memory", "reads_memory"]);
    expect(r).toEqual(["reads_memory", "reads_memory"]);
  });
});

describe("SkillIoSchema", () => {
  it("accepts a JSON-Schema-shaped object", () => {
    const schema = {
      type: "object",
      properties: { x: { type: "integer" } },
      required: ["x"],
    };
    expect(SkillIoSchema.parse(schema)).toEqual(schema);
  });

  it("accepts an empty object", () => {
    expect(SkillIoSchema.parse({})).toEqual({});
  });

  it("rejects non-objects", () => {
    expect(() => SkillIoSchema.parse([])).toThrow();
    expect(() => SkillIoSchema.parse("schema")).toThrow();
    expect(() => SkillIoSchema.parse(null)).toThrow();
    expect(() => SkillIoSchema.parse(42)).toThrow();
  });
});

describe("ClassifierLogSchema", () => {
  const STUB = {
    classifier_version: "stub-0",
    risk_tier: "auto" as const,
    declared_effects: [],
    detected_effects: [],
    declared_secrets: [],
    declared_dependencies: [],
    validation_errors: [],
  };

  it("round-trips a stub log", () => {
    expect(ClassifierLogSchema.parse(STUB)).toEqual(STUB);
  });

  it.each([
    "classifier_version",
    "risk_tier",
    "declared_effects",
    "detected_effects",
    "declared_secrets",
    "validation_errors",
  ] as const)("rejects when %s is missing", (field) => {
    const { [field]: _omit, ...rest } = STUB;
    expect(() => ClassifierLogSchema.parse(rest)).toThrow();
  });

  it("rejects unknown risk_tier", () => {
    expect(() => ClassifierLogSchema.parse({ ...STUB, risk_tier: "danger" })).toThrow();
  });

  it("rejects empty classifier_version", () => {
    expect(() => ClassifierLogSchema.parse({ ...STUB, classifier_version: "" })).toThrow();
  });

  it("rejects unknown effect inside declared/detected", () => {
    expect(() => ClassifierLogSchema.parse({ ...STUB, declared_effects: ["foo"] })).toThrow();
    expect(() => ClassifierLogSchema.parse({ ...STUB, detected_effects: ["foo"] })).toThrow();
  });
});

describe("SkillManifestSchema cross-field rules", () => {
  it("triggers: [cron] without schedule rejects", () => {
    expect(() => SkillManifestSchema.parse({ ...MIN_MANIFEST, triggers: ["cron"] })).toThrow();
  });

  it("triggers: [cron] with schedule accepts", () => {
    const r = SkillManifestSchema.parse({
      ...MIN_MANIFEST,
      triggers: ["cron"],
      schedule: "0 9 * * *",
    });
    expect(r.triggers).toEqual(["cron"]);
    expect(r.schedule).toBe("0 9 * * *");
  });

  it("triggers: [manual] without schedule accepts", () => {
    const r = SkillManifestSchema.parse(MIN_MANIFEST);
    expect(r.triggers).toEqual(["manual"]);
    expect(r.schedule).toBeUndefined();
  });

  it("tier:wasm + isolation:subinterpreter silently drops isolation", () => {
    const r = SkillManifestSchema.parse({
      ...MIN_MANIFEST,
      isolation: "subinterpreter",
    });
    expect(r.isolation).toBeUndefined();
  });

  it("tier:wasm + isolation:recycle also silently drops", () => {
    const r = SkillManifestSchema.parse({
      ...MIN_MANIFEST,
      isolation: "recycle",
    });
    expect(r.isolation).toBeUndefined();
  });

  it("tier:container + isolation:subinterpreter preserved", () => {
    const r = SkillManifestSchema.parse({
      ...MIN_MANIFEST,
      tier: "container",
      isolation: "subinterpreter",
    });
    expect(r.isolation).toBe("subinterpreter");
  });

  it("tier:container with no isolation accepts (defaults undefined)", () => {
    const r = SkillManifestSchema.parse({ ...MIN_MANIFEST, tier: "container" });
    expect(r.isolation).toBeUndefined();
  });
});

describe("SkillManifestSchema name regex", () => {
  it.each([
    "a",
    "valid",
    "valid-name",
    "valid_name",
    "abc123",
    "a".repeat(64),
  ])("accepts %s", (name) => {
    expect(() => SkillManifestSchema.parse({ ...MIN_MANIFEST, name })).not.toThrow();
  });

  it.each([
    "",
    "1abc",
    "ABC",
    "Bad-Name",
    "a name",
    "a.b",
    "a/b",
    "a".repeat(65),
  ])("rejects %s", (name) => {
    expect(() => SkillManifestSchema.parse({ ...MIN_MANIFEST, name })).toThrow();
  });
});

describe("SkillManifestSchema description boundaries", () => {
  it("rejects under 10 chars", () => {
    expect(() => SkillManifestSchema.parse({ ...MIN_MANIFEST, description: "short" })).toThrow();
  });

  it("accepts exactly 10 chars", () => {
    expect(() =>
      SkillManifestSchema.parse({ ...MIN_MANIFEST, description: "0123456789" }),
    ).not.toThrow();
  });

  it("accepts exactly 500 chars", () => {
    expect(() =>
      SkillManifestSchema.parse({ ...MIN_MANIFEST, description: "x".repeat(500) }),
    ).not.toThrow();
  });

  it("rejects 501 chars", () => {
    expect(() =>
      SkillManifestSchema.parse({ ...MIN_MANIFEST, description: "x".repeat(501) }),
    ).toThrow();
  });
});

describe("SkillManifestSchema cost / resources boundaries", () => {
  it("cost_per_call_usd negative rejected", () => {
    expect(() =>
      SkillManifestSchema.parse({ ...MIN_MANIFEST, cost_per_call_usd: -0.01 }),
    ).toThrow();
  });

  it("cost_per_call_usd zero accepted (default)", () => {
    const r = SkillManifestSchema.parse(MIN_MANIFEST);
    expect(r.cost_per_call_usd).toBe(0);
  });

  it("cost_per_call_usd positive accepted", () => {
    const r = SkillManifestSchema.parse({ ...MIN_MANIFEST, cost_per_call_usd: 0.01 });
    expect(r.cost_per_call_usd).toBe(0.01);
  });

  it("resources.memory_mb 2048 accepted, 2049 rejected", () => {
    expect(() =>
      SkillManifestSchema.parse({ ...MIN_MANIFEST, resources: { memory_mb: 2048 } }),
    ).not.toThrow();
    expect(() =>
      SkillManifestSchema.parse({ ...MIN_MANIFEST, resources: { memory_mb: 2049 } }),
    ).toThrow();
  });

  it("resources.wall_clock_s 600 accepted, 601 rejected", () => {
    expect(() =>
      SkillManifestSchema.parse({ ...MIN_MANIFEST, resources: { wall_clock_s: 600 } }),
    ).not.toThrow();
    expect(() =>
      SkillManifestSchema.parse({ ...MIN_MANIFEST, resources: { wall_clock_s: 601 } }),
    ).toThrow();
  });

  it("resources.cpu_shares 4 accepted, 5 rejected", () => {
    expect(() =>
      SkillManifestSchema.parse({ ...MIN_MANIFEST, resources: { cpu_shares: 4 } }),
    ).not.toThrow();
    expect(() =>
      SkillManifestSchema.parse({ ...MIN_MANIFEST, resources: { cpu_shares: 5 } }),
    ).toThrow();
  });

  it("resources.* zero or negative rejected", () => {
    expect(() =>
      SkillManifestSchema.parse({ ...MIN_MANIFEST, resources: { memory_mb: 0 } }),
    ).toThrow();
    expect(() =>
      SkillManifestSchema.parse({ ...MIN_MANIFEST, resources: { wall_clock_s: -1 } }),
    ).toThrow();
  });

  it("resources.* non-integer rejected", () => {
    expect(() =>
      SkillManifestSchema.parse({ ...MIN_MANIFEST, resources: { memory_mb: 1.5 } }),
    ).toThrow();
  });
});

describe("SkillManifestSchema secrets union form", () => {
  it("accepts bare-string secret", () => {
    const r = SkillManifestSchema.parse({ ...MIN_MANIFEST, secrets: ["foo"] });
    expect(r.secrets).toEqual(["foo"]);
  });

  it("accepts object-form secret with binding", () => {
    const r = SkillManifestSchema.parse({
      ...MIN_MANIFEST,
      secrets: [
        {
          name: "github_token",
          binding: { destination: "https://api.github.com/*" },
        },
      ],
    });
    expect((r.secrets[0] as { name: string }).name).toBe("github_token");
  });

  it("accepts object-form secret without binding", () => {
    expect(() =>
      SkillManifestSchema.parse({ ...MIN_MANIFEST, secrets: [{ name: "foo" }] }),
    ).not.toThrow();
  });

  it("accepts mixed string + object forms in same array", () => {
    const r = SkillManifestSchema.parse({
      ...MIN_MANIFEST,
      secrets: ["bare_secret", { name: "scoped", binding: { destination: "https://x.com/*" } }],
    });
    expect(r.secrets).toHaveLength(2);
  });

  it("accepts substitute: 'url' literal", () => {
    expect(() =>
      SkillManifestSchema.parse({
        ...MIN_MANIFEST,
        secrets: [
          {
            name: "tok",
            binding: { destination: "https://x.com/*", substitute: "url" },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("accepts substitute: 'header:...' string", () => {
    expect(() =>
      SkillManifestSchema.parse({
        ...MIN_MANIFEST,
        secrets: [
          {
            name: "tok",
            binding: {
              destination: "https://x.com/*",
              substitute: "header:Authorization: Bearer {{value}}",
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects substitute that's neither 'url' nor starts with 'header:'", () => {
    expect(() =>
      SkillManifestSchema.parse({
        ...MIN_MANIFEST,
        secrets: [
          {
            name: "tok",
            binding: { destination: "https://x.com/*", substitute: "body:foo" },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects bare-string secret with empty name", () => {
    expect(() => SkillManifestSchema.parse({ ...MIN_MANIFEST, secrets: [""] })).toThrow();
  });

  it("accepts empty secrets array (default)", () => {
    const r = SkillManifestSchema.parse(MIN_MANIFEST);
    expect(r.secrets).toEqual([]);
  });
});

describe("SkillManifestSchema budget", () => {
  it("rejects zero or negative budget values", () => {
    expect(() =>
      SkillManifestSchema.parse({ ...MIN_MANIFEST, budget: { daily_usd: 0 } }),
    ).toThrow();
    expect(() =>
      SkillManifestSchema.parse({ ...MIN_MANIFEST, budget: { monthly_usd: -1 } }),
    ).toThrow();
  });

  it("accepts partial budget (only daily)", () => {
    const r = SkillManifestSchema.parse({
      ...MIN_MANIFEST,
      budget: { daily_usd: 1.0 },
    });
    expect(r.budget?.daily_usd).toBe(1.0);
    expect(r.budget?.monthly_usd).toBeUndefined();
  });
});

describe("SkillManifestSchema tier and triggers enums", () => {
  it("rejects unknown tier", () => {
    expect(() => SkillManifestSchema.parse({ ...MIN_MANIFEST, tier: "microvm" })).toThrow();
  });

  it.each(["manual", "cron", "event"] as const)("accepts trigger %s", (trigger) => {
    const r = SkillManifestSchema.parse({
      ...MIN_MANIFEST,
      triggers: [trigger],
      ...(trigger === "cron" && { schedule: "* * * * *" }),
    });
    expect(r.triggers).toContain(trigger);
  });

  it("rejects unknown trigger", () => {
    expect(() => SkillManifestSchema.parse({ ...MIN_MANIFEST, triggers: ["webhook"] })).toThrow();
  });
});
