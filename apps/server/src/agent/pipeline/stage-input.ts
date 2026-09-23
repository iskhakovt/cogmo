/**
 * The text a pipeline stage hands the agent — rendered into the synthetic
 * inbound the stage runner persists into the run's conversation.
 *
 * A stage does not get its own hidden prompt: the instructions arrive as a
 * visible user-role message, so the user reads exactly what the pipeline
 * asked for (design/pipelines.md → Definition Lifecycle: the preview IS the
 * contract). Typed artifacts from earlier stages are restated here because
 * they are the deterministic handoff; the prose reasoning behind them stays
 * in the conversation, which the turn already loads as history.
 */

import type { StageArtifact, StageOutputs } from "./run-types.js";
import type { Stage } from "./types.js";

/** Header line identifying the pipeline and the stage's position in it. */
function header(args: { pipelineName: string; stageIndex: number; stageCount: number }): string {
  return `[Pipeline "${args.pipelineName}" — stage ${args.stageIndex + 1}/${args.stageCount}]`;
}

function renderArtifact(artifact: StageArtifact): string {
  switch (artifact.kind) {
    case "text":
      return artifact.text;
    case "json":
      return JSON.stringify(artifact.value, null, 2);
  }
}

/**
 * Prior stages' artifacts, most useful first (definition order). Only stages
 * that actually produced one appear — a stage with no declared `output`
 * contributes nothing here.
 */
function renderPriorOutputs(stageOutputs: StageOutputs, priorStageIds: readonly string[]): string {
  const rendered = priorStageIds.flatMap((id) => {
    const artifact = stageOutputs[id];
    return artifact === undefined ? [] : [`### ${id}\n${renderArtifact(artifact)}`];
  });
  return rendered.length === 0 ? "" : `\n\n## Output of earlier stages\n\n${rendered.join("\n\n")}`;
}

export interface AgenticStageInputArgs {
  pipelineName: string;
  stage: Stage;
  stageIndex: number;
  stageCount: number;
  stageOutputs: StageOutputs;
  /** Stage ids before this one, in definition order. */
  priorStageIds: readonly string[];
  /** Revise feedback carried back from a gate, if the run is re-entering this stage. */
  note?: string;
}

/**
 * Body of the synthetic inbound for an `agentic` stage. `instructions` is
 * always present on an agentic stage (enforced in `validate.ts`); the
 * fallback keeps this total rather than throwing on a malformed pinned
 * definition, since a run in flight cannot be recompiled.
 */
export function buildAgenticStageInput(args: AgenticStageInputArgs): string {
  const note = args.note === undefined ? "" : `\n\n## Revision requested\n\n${args.note}`;
  const instructions = args.stage.instructions ?? "(this stage carries no instructions)";
  return (
    `${header(args)}\n\n${instructions}` +
    renderPriorOutputs(args.stageOutputs, args.priorStageIds) +
    note +
    "\n\nWhen this stage's work is done, call `complete_stage` to hand the result forward. " +
    "Until you do, the pipeline stays on this stage — so ask me anything you still need."
  );
}

export interface GatePromptArgs {
  pipelineName: string;
  stage: Stage;
  stageIndex: number;
  stageCount: number;
  /** Revise feedback, when the run re-entered this gate carrying one. */
  note?: string;
}

/**
 * Body of the gate message. Names both resolution routes, because the
 * inline keyboard only exists on channels that render one — everywhere else
 * `/gate` is the whole interface.
 */
export function buildGatePrompt(args: GatePromptArgs): string {
  const instructions = args.stage.instructions ?? "Approve to continue.";
  const note = args.note === undefined ? "" : `\n\n## Revision requested\n\n${args.note}`;
  return (
    `⏸️ ${header(args)} — waiting on you\n\n${instructions}${note}\n\n` +
    "Approve to continue, revise to send it back with feedback, or cancel the run. " +
    "Use the buttons, or reply `/gate approve`, `/gate revise <feedback>`, `/gate cancel`."
  );
}
