/**
 * Render a compiled pipeline definition as the human-readable preview the
 * user confirms before activation. The preview IS the contract — every
 * envelope decision (trigger, gates, timeout actions, loop bounds, tool
 * allowlists) must be visible in it, no hidden behavior
 * (design/pipelines.md → Definition Lifecycle).
 */

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
  switch (trigger.kind) {
    case "command":
      return `you say "${trigger.phrase}"`;
    case "cron":
      return `on schedule \`${trigger.schedule}\` (${trigger.timezone})`;
    case "event":
      return `on event \`${trigger.source}\`${trigger.filter ? ` matching \`${trigger.filter}\`` : ""}`;
  }
}

function renderStage(stage: Stage, definition: PipelineDefinition): string {
  const parts: string[] = [];

  switch (stage.kind) {
    case "agentic": {
      parts.push(stage.instructions ?? stage.id);
      if (stage.tools !== undefined) {
        parts.push(`_tools: ${stage.tools.join(", ")}_`);
      }
      if (stage.output !== undefined) {
        parts.push(`_produces: ${stage.output.kind}_`);
      }
      break;
    }
    case "gate": {
      parts.push(
        `**gate: ${stage.instructions ?? "your approval"}** (${stage.gate ? renderDeadline(stage.gate.timeout, stage.gate.onTimeout) : "no timeout"})`,
      );
      break;
    }
    case "wait": {
      const wait = stage.wait;
      parts.push(
        wait
          ? `wait for \`${wait.event}\`${wait.filter ? ` matching \`${wait.filter}\`` : ""} (${renderDeadline(wait.timeout, wait.onTimeout)})`
          : `wait (${stage.id})`,
      );
      break;
    }
  }

  if (stage.loop !== undefined) {
    const targetPosition = definition.stages.findIndex((s) => s.id === stage.loop?.backTo) + 1;
    parts.push(
      `→ repeat from step ${targetPosition} until "${stage.loop.until}", max ${stage.loop.maxIterations} rounds`,
    );
  }

  return parts.join(" ");
}

function renderDeadline(timeout: string, action: TimeoutAction): string {
  switch (action.kind) {
    case "proceed":
      return `${timeout} timeout, then proceeds`;
    case "abort":
      return `${timeout} timeout, then aborts`;
    case "remind":
      return `${timeout} timeout, reminds ×${action.maxReminders} then ${action.finalAction}s`;
  }
}
