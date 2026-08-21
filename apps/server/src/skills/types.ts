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
  "reads_filesystem",
  "writes_filesystem",
  "spawns_subprocess",
] as const;

export const SkillEffectsSchema = z.array(z.enum(SKILL_EFFECTS));
export type SkillEffect = (typeof SKILL_EFFECTS)[number];
export type SkillEffects = z.infer<typeof SkillEffectsSchema>;

/**
 * JSON-serialisable value — the closure of what survives a JSONB round-trip
 * cleanly. `z.unknown()` would let `Date`, `BigInt`, `undefined` keys, or
 * functions through and they'd either throw on `JSON.stringify` or get
 * silently coerced.
 */
const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * Generic JSON-Schema wrapper used for skill *outputs*. Outputs may be any
 * JSON Schema (string, number, array, object) — a skill that returns a
 * formatted message, a count, or an array doesn't need to wrap it in an
 * object. Zod's only job here is "this is a JSON-serialisable record" so the
 * store layer can round-trip JSONB safely; structural validation against the
 * schema itself happens at ajv-invoke time.
 *
 * Inputs use the stricter {@link SkillInputsSchema} — see its docstring.
 */
export const SkillIoSchema = z.record(z.string(), JsonValueSchema);
export type SkillIo = z.infer<typeof SkillIoSchema>;

/**
 * JSON-Schema wrapper for skill *inputs*. Inputs describe the LLM tool's
 * parameter object — both the Anthropic and OpenAI tool-call APIs require
 * `type: "object"`, and our internal `JsonSchema` (in `src/llm/types.ts`)
 * enforces the same literal. Pinning that constraint here at the manifest
 * boundary means:
 *
 * 1. `register` rejects bad inputs schemas at manifest-parse time with a
 *    precise error path (`inputs.type: expected literal "object"`), before
 *    any filesystem or DB write.
 * 2. The inferred TypeScript type for `manifest.inputs` carries `type:
 *    "object"` as a literal — the dynamic-tool-list builder can hand the
 *    value straight to the LLM provider's `JsonSchema` slot without an
 *    `as unknown` cast (the structural shapes match).
 *
 * `passthrough` keeps additional JSON-Schema keys (`additionalProperties`,
 * `enum`, `pattern`, etc.) without dropping or re-typing them — they're
 * round-tripped as `unknown` to the LLM, which is exactly what `JsonSchema`'s
 * index signature accepts.
 */
export const SkillInputsSchema = z
  .object({
    type: z.literal("object"),
    properties: z.record(z.string(), JsonValueSchema).optional(),
    required: z.array(z.string()).optional(),
  })
  .passthrough();
export type SkillInputs = z.infer<typeof SkillInputsSchema>;

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

/**
 * Egress allowlist. Absent means the skill has no network at all — `ctx.http`
 * refuses every destination — so reaching the internet is opted into per host
 * rather than out of. Entries are bare hostnames, optionally prefixed `*.` to
 * admit subdomains; `*.example.com` covers `api.example.com` but not
 * `example.com` itself, the rule TLS certificates use, so an apex needs its own
 * entry. A lone `*` does not parse: "anywhere" is the shape this block exists
 * to make unavailable. At least one label separator is required, which keeps
 * single-label internal names (`localhost`, a container alias) out — those
 * resolve onto the host's own network, which `ctx.http` refuses anyway.
 */
const SkillNetworkHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
    "must be a hostname, optionally prefixed '*.' — no scheme, port or path",
  );

export const SkillNetworkSchema = z.object({
  allow: z.array(SkillNetworkHostSchema).min(1),
});

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
 * Direct Python dep declared in `SKILL.md`. Strict `name==version` only. The
 * regex rejects ranges (`>=`, `<`), extras (`pkg[foo]`), URL/git specifiers,
 * and bare names — see `design/skills.md` → Dependencies for the rationale.
 * Transitive resolution lives in the generated `requirements.lock`.
 *
 * Name segment matches the PEP 508 distribution-name grammar (letter/digit at
 * the boundary, `._-` interior). Version segment is permissive — uv enforces
 * PEP 440 at resolve time, and overly-strict regex here would reject valid
 * pre-releases (`1.0rc1`), local-version segments (`1.0+local`), and epoch
 * forms (`1!2.0`, used when a project's versioning scheme resets).
 */
export const SkillDependencySchema = z
  .string()
  .regex(
    /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?==[a-zA-Z0-9.+!-]+$/i,
    "must be 'name==version' (no ranges, extras, URLs, or git refs)",
  );

/**
 * Canonical manifest schema for `SKILL.md` frontmatter. Source of truth for
 * the deploy contract; five consumers read it (register RPC, classifier,
 * dispatcher, tool registrar, dependency populator) — defining the shape once
 * prevents drift.
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

    inputs: SkillInputsSchema,
    outputs: SkillIoSchema.optional(),

    effects: SkillEffectsSchema.default([]),
    secrets: z.array(SkillSecretSchema).default([]),

    dependencies: z.array(SkillDependencySchema).default([]),

    network: SkillNetworkSchema.optional(),

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
  declared_dependencies: z.array(SkillDependencySchema).default([]),
  validation_errors: z.array(z.string()),
});
export type ClassifierLog = z.infer<typeof ClassifierLogSchema>;

/**
 * Per-invocation input/output blobs. The per-skill JSON Schema is enforced
 * at invoke time by ajv against the manifest's declared `inputs`/`outputs`;
 * here we just guarantee "valid JSON-shaped" — using `JsonValueSchema`
 * rather than `z.unknown()` so a bypass writer (future bug, store called
 * from another path) can't slip a `Date`/`BigInt`/`undefined` past the
 * JSONB boundary. CLAUDE.md mandates Zod on read AND write for every JSONB
 * column.
 */
export const SkillInvocationInputsSchema = JsonValueSchema;
export const SkillInvocationOutputSchema = JsonValueSchema;

/**
 * Per-run resource metrics persisted as JSONB on `skill_runs.resource_usage`.
 * Populated by the host at finalisation time:
 *
 * - `wallClockMs` — `finishedAt - createdAt` for every run, including
 *   timeouts and crashes. Always set.
 * - `peakMemoryBytes` — `resource.getrusage(RUSAGE_SELF).ru_maxrss * 1024`
 *   reported by the tier-2 supervisor's per-task child before it emits
 *   `task_result`. Linux `ru_maxrss` is in kilobytes, so we scale to
 *   bytes for consistency. `null` for tier-1 (Pyodide WASM heap is
 *   process-wide via `getrusage` — would inflate under concurrent
 *   workers), and `null` for tier-2 runs that didn't complete normally
 *   (wall-clock kill, crash) since the supervisor synthesises the
 *   `task_result` without rusage in those cases.
 *
 * Shape mirrors `coding_tasks.resource_usage` — one blob per "what the
 * sandbox cost us." Adding CPU time / I/O bytes / fork count later is a
 * Zod-schema extension, no migration.
 */
export const SkillRunResourceUsageSchema = z.object({
  wallClockMs: z.number().int().nonnegative(),
  peakMemoryBytes: z.number().int().nonnegative().nullable(),
});
export type SkillRunResourceUsage = z.infer<typeof SkillRunResourceUsageSchema>;
