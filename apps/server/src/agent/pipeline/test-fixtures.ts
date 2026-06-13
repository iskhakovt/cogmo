/**
 * Shared pipeline test fixtures. `validPipelineDefinition()` returns a
 * fresh deep copy per call so tests can mutate freely — it models the
 * canonical coding flow: gather context → plan gate → implement, with a
 * review loop on the last stage.
 */

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
