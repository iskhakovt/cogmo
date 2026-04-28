import { z } from "zod";

/**
 * Effects a skill may declare in its `SKILL.md` frontmatter. Drives the risk
 * classifier (P3.3) — `auto` skills declare none of the message/delete/financial
 * effects; `notify` admits idempotent writes; `approve` is forced by anything
 * destructive or external-messaging. Static analysis can also _detect_ effects
 * the manifest didn't declare and force them in.
 */
export const SKILL_EFFECTS = [
  "reads_memory",
  "writes_memory",
  "reads_user_data",
  "writes_user_data",
  "sends_email",
  "sends_message",
  "posts_public",
  "deletes_external",
  "financial",
  "writes_filesystem",
  "spawns_subprocess",
] as const;

export const SkillEffectsSchema = z.array(z.enum(SKILL_EFFECTS));
export type SkillEffect = (typeof SKILL_EFFECTS)[number];
export type SkillEffects = z.infer<typeof SkillEffectsSchema>;

/**
 * Opaque-JSON-Schema wrapper. The actual shape is whatever the skill declared
 * in its manifest; we validate inputs at invoke time via ajv, not at the store
 * boundary. Zod's job here is "this is a JSON object" — that's all the store
 * needs to round-trip JSONB safely.
 */
export const SkillIoSchema = z.record(z.string(), z.unknown());
export type SkillIo = z.infer<typeof SkillIoSchema>;

/**
 * Manifest-declared secret entry. v1 supports a string (secret name only); the
 * binding object form is reserved for the future egress-proxy substitution
 * design (`design/skills.md` → Egress-proxy substitution `[research]`). The
 * binding fields are accepted at parse time so a future skill author can write
 * them without re-versioning the manifest, but v1 ignores them at runtime.
 */
const SkillSecretSchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    binding: z
      .object({
        destination: z.string().min(1),
        substitute: z.union([z.literal("url"), z.string().startsWith("header:")]).optional(),
      })
      .optional(),
  }),
]);

const SkillResourcesSchema = z.object({
  memory_mb: z.number().int().positive().max(2048).optional(),
  wall_clock_s: z.number().int().positive().max(600).optional(),
  cpu_shares: z.number().int().positive().max(4).optional(),
});

const SkillBudgetSchema = z.object({
  daily_usd: z.number().positive().optional(),
  monthly_usd: z.number().positive().optional(),
  per_invocation_usd_cap: z.number().positive().optional(),
});

/**
 * Canonical manifest schema for `SKILL.md` frontmatter. Source of truth for
 * the deploy contract; four consumers read it (register RPC, classifier,
 * dispatcher, tool registrar) — defining the shape once prevents drift.
 *
 * `isolation` only applies to `tier: container`; on `tier: wasm` the field is
 * silently coerced to `undefined` because Pyodide ships single-heap CPython
 * with no subinterpreter support. `cron` triggers require a `schedule`.
 */
export const SkillManifestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/, "name must be lowercase, start with a letter"),
    description: z.string().min(10).max(500),

    tier: z.enum(["wasm", "container"]),
    isolation: z.enum(["subinterpreter", "recycle"]).optional(),

    triggers: z.array(z.enum(["manual", "cron", "event"])).default(["manual"]),
    schedule: z.string().optional(),

    inputs: SkillIoSchema,
    outputs: SkillIoSchema.optional(),

    effects: SkillEffectsSchema.default([]),
    secrets: z.array(SkillSecretSchema).default([]),

    resources: SkillResourcesSchema.optional(),

    cost_per_call_usd: z.number().nonnegative().default(0),
    budget: SkillBudgetSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.triggers.includes("cron") && !manifest.schedule) {
      ctx.addIssue({
        code: "custom",
        path: ["schedule"],
        message: "schedule is required when 'cron' is in triggers",
      });
    }
  })
  .transform((manifest) => {
    // tier: wasm has no isolation knob (single-heap WASM CPython). Drop the
    // field silently rather than rejecting — friendlier to skill authors who
    // copy a container manifest as a starting point.
    if (manifest.tier === "wasm" && manifest.isolation !== undefined) {
      return { ...manifest, isolation: undefined };
    }
    return manifest;
  });
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

/**
 * What the classifier records on every deploy. Stored as JSONB on
 * `skill_deploys.classifier_log`; replayed in the audit UI and used by the
 * deploy-pipeline graduation logic. P3.1 stub-`register` writes a constant
 * blob with `classifier_version: "stub-0"`; P3.3 fills in real values without
 * a schema change.
 */
export const ClassifierLogSchema = z.object({
  classifier_version: z.string().min(1),
  risk_tier: z.enum(["auto", "notify", "approve"]),
  declared_effects: SkillEffectsSchema,
  detected_effects: SkillEffectsSchema,
  declared_secrets: z.array(z.string().min(1)),
  validation_errors: z.array(z.string()),
});
export type ClassifierLog = z.infer<typeof ClassifierLogSchema>;

/**
 * Per-invocation input/output blobs. Pass-through `z.unknown()` wrappers — the
 * per-skill JSON Schema is enforced at invoke time by ajv against the manifest's
 * declared `inputs`/`outputs`, not at the store layer. The store only needs to
 * guarantee "valid JSON".
 */
export const SkillInvocationInputsSchema = z.unknown();
export const SkillInvocationOutputSchema = z.unknown();
