/**
 * Narrow a turn's tools to what its pipeline stage declared, and give it the
 * one tool that ends the stage.
 *
 * The allowlist is resolved here, at turn-build time, rather than only when
 * the definition compiled: the profile's own toolset may have changed since,
 * tools may have been added or removed, and least privilege is a property of
 * the call that actually happens. Resolution is an intersection — a stage can
 * only ever narrow what the profile already permits, never widen it.
 */

import { logger } from "../../logger.js";
import { compileToolMatchers } from "../tool-matchers.js";
import { ToolRegistry } from "../tools.js";
import { buildCompleteStageTool, COMPLETE_STAGE_TOOL_NAME } from "./complete-stage-tool.js";
import type { PipelineStageContext } from "./load-stage-context.js";
import { PIPELINE_TOOL_NAMES } from "./tools.js";

const log = logger.child({ component: "pipeline.stage-tools" });

/**
 * Tools a pipeline stage never gets, whatever it declared:
 *
 * - the pipeline-authoring tools, because a run that can define or activate
 *   pipelines is a self-modification path around the preview/confirm gate
 *   (design/pipelines.md → Safety);
 * - `start_pipeline`, since one conversation hosts one run at a time and a
 *   stage starting a sibling run would deadlock on that invariant.
 *
 * `PIPELINE_TOOL_NAMES` covers all of them — the authoring tools and
 * `start_pipeline` are the same registry.
 */
const FORBIDDEN_IN_STAGE: ReadonlySet<string> = new Set(PIPELINE_TOOL_NAMES);

/**
 * Drop the tools a turn inside a live run may never have, whatever stage it
 * sits on. A gate turn is an ordinary turn in every other respect — the user
 * is deciding, and can ask anything about what they are approving — but the
 * run is live, so the self-modification denial still applies.
 */
export function denyRunForbiddenTools(turnTools: ToolRegistry): ToolRegistry {
  const allowed = new ToolRegistry();
  for (const spec of turnTools.snapshot()) {
    if (!FORBIDDEN_IN_STAGE.has(spec.name)) allowed.register(spec);
  }
  return allowed;
}

/**
 * Build the registry for a turn that belongs to an `agentic` stage.
 *
 * A stage that declares no `tools` inherits the profile's toolset unchanged —
 * the compiler omits the field for stages that are pure conversation, and
 * denying everything there would make them unable to answer. A stage that
 * declares globs matching nothing keeps `complete_stage` alone, which is the
 * honest outcome: it can still finish, it just cannot act.
 */
export function buildStageToolRegistry(
  turnTools: ToolRegistry,
  context: PipelineStageContext,
): ToolRegistry {
  const globs = context.stage.tools;
  const matcher = globs === undefined ? () => true : compileToolMatchers(globs);

  const scoped = new ToolRegistry();
  for (const spec of denyRunForbiddenTools(turnTools).snapshot()) {
    if (matcher(spec.name)) scoped.register(spec);
  }

  // Registered last so a same-named tool from any other source cannot shadow
  // the stage's only exit.
  scoped.register(
    buildCompleteStageTool(context.stage, {
      runId: context.runId,
      stageId: context.stageId,
      iteration: context.iteration,
    }),
  );

  const resolved = scoped.snapshot().length - 1;
  if (globs !== undefined && resolved === 0) {
    log.warn(
      { runId: context.runId, stageId: context.stageId, globs },
      "pipeline stage tool allowlist resolved to nothing in this profile's toolset",
    );
  }
  return scoped;
}

export { COMPLETE_STAGE_TOOL_NAME };
