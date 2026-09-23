/**
 * Shared pipeline test fixtures. `validPipelineDefinition()` returns a
 * fresh deep copy per call so tests can mutate freely — it models the
 * canonical coding flow: gather context → plan gate → implement, with a
 * review loop on the last stage.
 */

import type { PipelineDefinitionRow, PipelineRunRow } from "./store/index.js";
import type { PipelineDefinition } from "./types.js";

export const FIXTURE_TOOLS = ["memory_recall", "web_search", "delegate_coding", "read_file"];

export function validPipelineDefinition(): PipelineDefinition {
  return structuredClone(BASE);
}

const BASE: PipelineDefinition = {
  name: "issue-to-pr",
  trigger: { kind: "command", phrase: "start the issue pipeline" },
  stages: [
    {
      id: "gather-context",
      kind: "agentic",
      instructions: "Chat with the user until you understand the issue scope.",
      tools: ["memory_recall", "web_search"],
      output: { kind: "text" },
    },
    {
      id: "plan-gate",
      kind: "gate",
      instructions: "Present the plan and get approval.",
      gate: {
        timeout: "3d",
        onTimeout: { kind: "remind", maxReminders: 3, finalAction: "abort" },
      },
    },
    {
      id: "implement",
      kind: "agentic",
      instructions: "Implement the plan via coding delegation.",
      tools: ["delegate_coding"],
      loop: {
        backTo: "plan-gate",
        until: "the user is satisfied with the result",
        maxIterations: 5,
      },
    },
  ],
};

/** The fixture with its loop stripped — the linear shape the engine executes. */
export function linearPipelineDefinition(): PipelineDefinition {
  const definition = validPipelineDefinition();
  for (const stage of definition.stages) {
    delete stage.loop;
  }
  return definition;
}

/** A stored definition row wrapping `compiled`, active by default. */
export function pipelineDefinitionRow(
  overrides: Partial<PipelineDefinitionRow> = {},
): PipelineDefinitionRow {
  return {
    id: "def-1",
    userId: "user-1",
    name: "issue-to-pr",
    version: 2,
    sourceText: "source",
    compiled: linearPipelineDefinition(),
    active: true,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

/** A run row sitting at the definition's first stage. */
export function pipelineRunRow(overrides: Partial<PipelineRunRow> = {}): PipelineRunRow {
  return {
    id: "run-1",
    definitionId: "def-1",
    conversationId: "conv-1",
    status: "running",
    currentStage: "gather-context",
    iteration: 0,
    stageOutputs: {},
    failureReason: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}
