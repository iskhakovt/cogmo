/**
 * Render a compiled pipeline definition as the human-readable preview the
 * user confirms before activation. The preview IS the contract — every
 * envelope decision (trigger, gates, timeout actions, loop bounds, tool
 * allowlists) must be visible in it, no hidden behavior
 * (design/pipelines.md → Definition Lifecycle).
 */

import { match } from "ts-pattern";
import type { PipelineDefinition, Stage, TimeoutAction } from "./types.js";

export function renderPipelinePreview(definition: PipelineDefinition): string {
  const lines: string[] = [
    `**Pipeline: ${definition.name}**`,
    `Trigger: ${renderTrigger(definition)}`,
    "",
  ];
  definition.stages.forEach((stage, i) => {
    lines.push(`${i + 1}. ${renderStage(stage, definition)}`);
  });
  return lines.join("\n");
}

function renderTrigger(definition: PipelineDefinition): string {
  const { trigger } = definition;
  return match(trigger)
    .with({ kind: "command" }, (t) => `you say "${t.phrase}"`)
    .with({ kind: "cron" }, (t) => `on schedule \`${t.schedule}\` (${t.timezone})`)
    .with(
      { kind: "event" },
      (t) => `on event \`${t.source}\`${t.filter ? ` matching \`${t.filter}\`` : ""}`,
    )
    .exhaustive();
}

function renderStage(stage: Stage, definition: PipelineDefinition): string {
  const parts: string[] = match(stage)
    .with({ kind: "agentic" }, (s) => [
      s.instructions ?? s.id,
      ...(s.tools !== undefined ? [`_tools: ${s.tools.join(", ")}_`] : []),
      ...(s.output !== undefined ? [`_produces: ${s.output.kind}_`] : []),
    ])
    .with({ kind: "gate" }, (s) => [
      `**gate: ${s.instructions ?? "your approval"}** (${s.gate ? renderDeadline(s.gate.timeout, s.gate.onTimeout) : "no timeout"})`,
    ])
    .with({ kind: "wait" }, (s) => {
      const wait = s.wait;
      return [
        wait
          ? `wait for \`${wait.event}\`${wait.filter ? ` matching \`${wait.filter}\`` : ""} (${renderDeadline(wait.timeout, wait.onTimeout)})`
          : `wait (${s.id})`,
      ];
    })
    .exhaustive();

  if (stage.loop !== undefined) {
    const targetPosition = definition.stages.findIndex((s) => s.id === stage.loop?.backTo) + 1;
    parts.push(
      `→ repeat from step ${targetPosition} until "${stage.loop.until}", max ${stage.loop.maxIterations} rounds`,
    );
  }

  return parts.join(" ");
}

function renderDeadline(timeout: string, action: TimeoutAction): string {
  return match(action)
    .with({ kind: "proceed" }, () => `${timeout} timeout, then proceeds`)
    .with({ kind: "abort" }, () => `${timeout} timeout, then aborts`)
    .with(
      { kind: "remind" },
      (a) => `${timeout} timeout, reminds ×${a.maxReminders} then ${a.finalAction}s`,
    )
    .exhaustive();
}
