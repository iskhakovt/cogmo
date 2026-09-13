/**
 * Which parts of a compiled envelope the run engine can execute today.
 *
 * The compiler accepts the full definition grammar (loops, `wait` stages,
 * cron and event triggers, `plan` / `pr_metadata` artifacts), so a definition
 * can compile, preview and activate before its features are runnable.
 * Starting a run checks here first and refuses with the list, rather than
 * failing partway through a run that could never have finished.
 */

import type { PipelineDefinition } from "./types.js";

export function findUnsupportedFeatures(definition: PipelineDefinition): string[] {
  const trigger =
    definition.trigger.kind === "command" ? [] : [`${definition.trigger.kind} trigger`];
  const stages = definition.stages.flatMap((stage) => [
    ...(stage.kind === "wait" ? [`wait stage "${stage.id}"`] : []),
    ...(stage.loop !== undefined ? [`loop on stage "${stage.id}"`] : []),
    ...(stage.output?.kind === "plan" || stage.output?.kind === "pr_metadata"
      ? [`${stage.output.kind} output on stage "${stage.id}"`]
      : []),
  ]);
  return [...trigger, ...stages];
}
