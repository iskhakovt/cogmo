/**
 * Run-state schemas — the typed artifacts a pipeline run accumulates as it
 * advances through its stages. Distinct lifecycle from the definition
 * schemas in `types.ts`: those compile once and freeze per version; these
 * are produced and mutated per run.
 *
 * A stage's `output` declaration (definition-side {@link StageOutput})
 * names the *kind* a stage will produce; a {@link StageArtifact} is the
 * produced *value*. The engine produces `text` and `json`; `start_pipeline`
 * refuses definitions whose stages declare `plan` or `pr_metadata`.
 */

import { z } from "zod";

/**
 * A value an agentic stage produced, keyed by the same `kind` discriminant
 * as the definition's `StageOutput`. Stored on the run so later stages can
 * read prior handoffs deterministically (the full transcript stays in the
 * run conversation for the prose context — see design/pipelines.md → Context
 * handoff).
 */
export const StageArtifactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  z.object({ kind: z.literal("json"), value: z.record(z.string(), z.unknown()) }).strict(),
]);

export type StageArtifact = z.infer<typeof StageArtifactSchema>;

/**
 * `stageId → latest artifact`. A loop keeps only the latest iteration's
 * artifact per stage (latest-wins, intentional — earlier iterations'
 * reasoning survives in the run conversation). Empty `{}` at run start.
 */
export const StageOutputsSchema = z.record(z.string(), StageArtifactSchema);

export type StageOutputs = z.infer<typeof StageOutputsSchema>;

/**
 * The resolution that claimed the run's latest gate. `resolverRunId` is its
 * Inngest function run, stable across that run's retries, so a re-run step
 * recognises its own claim. Written with the `waiting_gate → running` flip.
 */
export const GateResolutionSchema = z
  .object({ gateKey: z.string().min(1), resolverRunId: z.string().min(1) })
  .strict();

export type GateResolution = z.infer<typeof GateResolutionSchema>;
