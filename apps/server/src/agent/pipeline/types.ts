/**
 * Pipeline definition schemas — the typed envelope a user's free-text
 * pipeline description compiles into.
 *
 * Two layers with different determinism (design/pipelines.md → Core
 * Decision): the *envelope* (trigger, stage sequence, gates, loop bounds,
 * tool allowlists) is compiled once and frozen per version; each stage's
 * *instructions* stay as the user's prose, re-interpreted by the agent at
 * run time.
 *
 * Everything here is structural validation. Cross-field rules (loop-scope
 * disjointness, kind/field consistency, tool-glob resolution) live in
 * `validate.ts` — they need context (available tools, known event sources)
 * that a Zod schema can't carry.
 */

import { z } from "zod";

/** Stable slug for stage ids and pipeline names — run state keys off these. */
const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * ms-style duration constrained to minutes/hours/days/weeks. The
 * constrained grammar excludes ms-style's `M`-ambiguity (months vs
 * minutes) and months/years entirely — engine waits cap at ~1 year
 * anyway. Strings pass to Inngest's `waitForEvent`/`sleep` untouched;
 * the DB-park path parses with {@link parseDurationMs}.
 */
export const DURATION_REGEX = /^\d+(\.\d+)?(m|h|d|w)$/;

export const DurationSchema = z
  .string()
  .regex(DURATION_REGEX, "duration must match e.g. '30m', '3h', '3d', '2w'");

const DURATION_UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Upper bound on any single wait — matches the engine's ~1-year pause ceiling. */
export const MAX_DURATION_MS = 366 * 86_400_000;

/**
 * Parse a {@link DurationSchema}-valid string to milliseconds. Throws on
 * strings that don't match the grammar — callers parse post-validation,
 * so a throw here is a programmer error, not user input.
 */
export function parseDurationMs(duration: string): number {
  const match = DURATION_REGEX.exec(duration);
  if (!match) {
    throw new Error(`parseDurationMs: "${duration}" does not match the duration grammar`);
  }
  const multiplier = match[2] !== undefined ? DURATION_UNIT_MS[match[2]] : undefined;
  if (multiplier === undefined) {
    throw new Error(`parseDurationMs: unknown unit in "${duration}"`);
  }
  return Number.parseFloat(duration) * multiplier;
}

/**
 * Every timeout resolves to a terminating action — `remind` re-arms the
 * deadline and notifies at most `maxReminders` times, then falls through
 * to its terminal `finalAction`. No unbounded waits.
 */
export const TimeoutActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("proceed") }).strict(),
  z.object({ kind: z.literal("abort") }).strict(),
  z
    .object({
      kind: z.literal("remind"),
      maxReminders: z.number().int().min(1).max(10),
      finalAction: z.enum(["proceed", "abort"]),
    })
    .strict(),
]);

export type TimeoutAction = z.infer<typeof TimeoutActionSchema>;

/**
 * Built-in artifact kinds are the shapes the orchestrator can act on
 * deterministically (safe-outputs). `json` carries a compiler-emitted
 * JSON Schema validated structurally at run time — user-shaped handoffs
 * need no Cogmo code change. The schema object itself is checked against
 * the JSON Schema meta-schema in `validate.ts` (ajv), not here.
 */
export const StageOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan") }).strict(),
  z.object({ kind: z.literal("pr_metadata") }).strict(),
  z.object({ kind: z.literal("text") }).strict(),
  z
    .object({
      kind: z.literal("json"),
      schema: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);

export type StageOutput = z.infer<typeof StageOutputSchema>;

export const TriggerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("command"),
      /** Chat phrase the user says to start a run, e.g. "start the release pipeline". */
      phrase: z.string().min(3).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cron"),
      /** Standard 5-field cron — validated against croner in `validate.ts`. */
      schedule: z.string().min(9).max(100),
      /** IANA timezone, e.g. "Europe/London". */
      timezone: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("event"),
      /** Inbound event name on the bus, e.g. "github/pr.review_submitted". */
      source: z.string().min(1).max(200),
      /** Optional CEL filter over the event payload. */
      filter: z.string().min(1).max(500).optional(),
    })
    .strict(),
]);

export type Trigger = z.infer<typeof TriggerSchema>;

const GateSchema = z
  .object({
    timeout: DurationSchema,
    onTimeout: TimeoutActionSchema,
  })
  .strict();

const WaitSchema = z
  .object({
    /** External event name the run parks on, e.g. "github/pr.review_submitted". */
    event: z.string().min(1).max(200),
    /** Optional CEL filter matched against the event payload (slice 3). */
    filter: z.string().min(1).max(500).optional(),
    timeout: DurationSchema,
    onTimeout: TimeoutActionSchema,
  })
  .strict();

const LoopSchema = z
  .object({
    /** Earlier stage id to jump back to. */
    backTo: z.string().regex(SLUG_REGEX),
    /** Prose condition an LLM step evaluates at run time ("all review threads resolved"). */
    until: z.string().min(3).max(500),
    /** Hard code-owned cap — the run-time evaluator cannot extend it. */
    maxIterations: z.number().int().min(1).max(50),
  })
  .strict();

export const StageSchema = z
  .object({
    id: z.string().regex(SLUG_REGEX).min(1).max(64),
    kind: z.enum(["agentic", "gate", "wait"]),
    /**
     * The user's prose for this stage, interpreted at run time. Required
     * for agentic/gate (enforced in `validate.ts`); optional annotation on
     * wait stages, which have nothing to interpret.
     */
    instructions: z.string().min(1).max(4000).optional(),
    /** Tool allowlist globs (agentic stages only), resolved against the tool registry. */
    tools: z.array(z.string().min(1)).min(1).max(50).optional(),
    /** Typed handoff to later stages (agentic stages only). */
    output: StageOutputSchema.optional(),
    gate: GateSchema.optional(),
    wait: WaitSchema.optional(),
    loop: LoopSchema.optional(),
  })
  .strict();

export type Stage = z.infer<typeof StageSchema>;

export const PipelineDefinitionSchema = z
  .object({
    name: z.string().regex(SLUG_REGEX).min(1).max(64),
    trigger: TriggerSchema,
    stages: z.array(StageSchema).min(1).max(20),
  })
  .strict();

export type PipelineDefinition = z.infer<typeof PipelineDefinitionSchema>;
