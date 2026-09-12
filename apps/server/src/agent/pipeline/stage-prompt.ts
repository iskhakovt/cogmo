/**
 * The user-role message an `agentic` stage turn runs on. The stage's own
 * prose is the objective; typed artifacts from earlier stages are the
 * deterministic handoff (design/pipelines.md → Context handoff). Earlier
 * stages' full transcripts are already in the run conversation's history,
 * so this message carries only what the envelope makes authoritative.
 */

import type { StageOutputs } from "./run-types.js";
import type { PipelineDefinition, Stage } from "./types.js";

export function buildStagePrompt(args: {
  definition: PipelineDefinition;
  stage: Stage;
  stageOutputs: StageOutputs;
}): string {
  const { definition, stage, stageOutputs } = args;
  const position = definition.stages.findIndex((s) => s.id === stage.id) + 1;

  const sections = [
    `# Pipeline "${definition.name}" — stage ${position} of ${definition.stages.length}: ${stage.id}`,
    "You are executing one stage of a pipeline the user defined. Do this stage's work and nothing beyond it — later stages run separately.",
    `## Instructions\n\n${stage.instructions ?? ""}`,
  ];

  const handoffs = Object.entries(stageOutputs);
  if (handoffs.length > 0) {
    const rendered = handoffs.map(([stageId, artifact]) => {
      const body =
        artifact.kind === "text"
          ? artifact.text
          : `\`\`\`json\n${JSON.stringify(artifact.value, null, 2)}\n\`\`\``;
      return `### ${stageId}\n\n${body}`;
    });
    sections.push(`## Outputs from earlier stages\n\n${rendered.join("\n\n")}`);
  }

  if (stage.output?.kind === "text") {
    sections.push(
      "## Output\n\nEnd with a final reply that is this stage's result. Later stages receive that reply verbatim.",
    );
  } else if (stage.output?.kind === "json") {
    sections.push(
      "## Output\n\nEnd with a final reply that states this stage's result completely. It will be converted into structured data matching this JSON Schema, so every required field must be derivable from it:\n\n" +
        `\`\`\`json\n${JSON.stringify(stage.output.schema, null, 2)}\n\`\`\``,
    );
  }

  return sections.join("\n\n");
}
