/**
 * `complete_stage` — the only exit from an agentic pipeline stage.
 *
 * A stage ends because the model says it is done and hands over a typed
 * artifact, not because a turn happened to finish. That distinction is what
 * lets a stage span several turns ("chat with me until I have enough") and
 * what gives the orchestrator something deterministic to act on: the model
 * produces artifacts, the engine performs the transitions
 * (design/pipelines.md → Safety, Writes as safe-outputs).
 *
 * The tool exists only inside a turn the engine has scoped to a stage — it
 * is built per turn from the pinned definition, so its schema and
 * description describe *this* stage's declared output.
 */

import { Ajv } from "ajv";
import { type ZodType, z } from "zod";
import { defineTool, type ToolSpec } from "../tools.js";
import type { StageArtifact } from "./run-types.js";
import type { Stage, StageOutput } from "./types.js";

export const COMPLETE_STAGE_TOOL_NAME = "complete_stage";

/** One process-wide Ajv, same settings as the definition-validation pass. */
const ajv = new Ajv({ allErrors: true, strict: false });

/** Where a run sits — the coordinates a completion is recorded against. */
export interface StageCursor {
  runId: string;
  stageId: string;
  iteration: number;
}

const summarySchema = z.object({
  summary: z
    .string()
    .min(1)
    .describe("One or two sentences on what this stage produced, for the run log."),
});

const textSchema = z.object({
  text: z.string().min(1).describe("The stage's text output, handed to every later stage."),
});

const jsonSchema = z.object({
  value: z
    .record(z.string(), z.unknown())
    .describe(
      "The stage's JSON output. Must satisfy the schema quoted in this tool's description.",
    ),
});

function describeOutput(output: StageOutput | undefined): string {
  if (output === undefined) {
    return "This stage declares no typed output — pass a short `summary` of what you did.";
  }
  switch (output.kind) {
    case "text":
      return "This stage produces text — pass the finished text as `text`.";
    case "json":
      return (
        "This stage produces JSON — pass an object as `value` satisfying this JSON Schema:\n" +
        `${JSON.stringify(output.schema)}\n` +
        "The call is rejected with the validation errors if it does not, so you can correct and retry."
      );
    case "plan":
    case "pr_metadata":
      // Unreachable: `startPipelineRun` refuses a definition declaring these
      // kinds, since nothing produces them until coding-delegation stages land.
      return "This stage's output kind is not supported yet.";
  }
}

/**
 * Build the per-turn `complete_stage` tool for `stage` — one spec per
 * output kind, each with the schema and the artifact mapping that kind
 * implies.
 */
export function buildCompleteStageTool(stage: Stage, cursor: StageCursor): ToolSpec {
  const output = stage.output;
  const describe = (schemaNote: string) =>
    `Finish pipeline stage "${stage.id}" and hand its result to the next stage. ` +
    `Call this once the stage's work is actually done — the pipeline waits here until you do, ` +
    `so you can keep working or ask the user questions first. ${schemaNote}`;

  if (output === undefined) {
    return build(describe(describeOutput(output)), summarySchema, cursor, () => null);
  }
  if (output.kind === "json") {
    const validate = ajv.compile(output.schema);
    return build(describe(describeOutput(output)), jsonSchema, cursor, (input) => {
      if (!validate(input.value)) {
        const detail = validate.errors
          ?.map((e) => `${e.instancePath || "/"} ${e.message}`)
          .join("; ");
        return `The value does not satisfy the stage's declared schema: ${detail}. Fix it and call complete_stage again.`;
      }
      return { kind: "json", value: input.value };
    });
  }
  return build(describe(describeOutput(output)), textSchema, cursor, (input) => ({
    kind: "text",
    text: input.text,
  }));
}

/**
 * Shared spec for every output kind. `durable: true` — the handler records
 * the completion that moves the run; a non-durable handler would re-record
 * once per remaining step boundary of the turn. The record carries a
 * cursor-keyed dedup id and the store's cursor guard makes a second delivery
 * a no-op, so all three layers agree that a stage completes once.
 *
 * `toArtifact` returns the artifact to store, or a string to hand back to the
 * model as a correction — the declared JSON Schema is enforced there, since
 * the tool's own input schema can only say "an object".
 */
function build<T>(
  description: string,
  schema: ZodType<T>,
  cursor: StageCursor,
  toArtifact: (input: T) => StageArtifact | null | string,
): ToolSpec {
  return defineTool({
    name: COMPLETE_STAGE_TOOL_NAME,
    description,
    schema,
    durable: true,
    parallelSafe: false,
    sideEffectful: true,
    invocationBudget: 2,
    handler: async (input, service) => {
      const artifact = toArtifact(input);
      if (typeof artifact === "string") return artifact;
      const pipelines = service.pipelines;
      if (!pipelines) {
        throw new Error("Pipelines are unavailable in this context.");
      }
      await pipelines.completeStage({ ...cursor, artifact });
      return JSON.stringify({
        ok: true,
        stage: cursor.stageId,
        note: "Stage recorded. The pipeline moves on by itself — tell the user what you produced and stop.",
      });
    },
  });
}
