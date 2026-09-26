/**
 * The built-in agent surface: the service guidance rendered into every
 * prompt's `# Capabilities` section and the tools registered at boot.
 * `src/index.ts` wires both into production; the live evals build their
 * prompt from the same lists so they measure what production sends.
 */

import { registerSkillTool, SKILLS_PROMPT_GUIDANCE } from "../skills/skills-tool.js";
import { DELEGATE_CODING_GUIDANCE, delegateCodingTool } from "./coding/tool.js";
import { coreMemoryTools } from "./core-memory-tools.js";
import { fileTools } from "./file-tools.js";
import { FILES_PROMPT_GUIDANCE } from "./files.js";
import { memoryTools } from "./memory-tools.js";
import { PIPELINES_PROMPT_GUIDANCE, pipelineTools } from "./pipeline/tools.js";
import { schedulingTools } from "./scheduling/tools.js";
import { CORE_MEMORY_PROMPT_GUIDANCE, MEMORY_PROMPT_GUIDANCE } from "./service.js";
import { SUBAGENT_PROMPT_GUIDANCE } from "./subagent/sub-agent-tool-builder.js";
import type { ToolSpec } from "./tools.js";

/** Service guidance, in the order the `# Capabilities` section renders it. */
export const BUILT_IN_SERVICE_GUIDANCE: ReadonlyArray<string> = [
  MEMORY_PROMPT_GUIDANCE,
  CORE_MEMORY_PROMPT_GUIDANCE,
  FILES_PROMPT_GUIDANCE,
  DELEGATE_CODING_GUIDANCE,
  SKILLS_PROMPT_GUIDANCE,
  SUBAGENT_PROMPT_GUIDANCE,
  PIPELINES_PROMPT_GUIDANCE,
];

/**
 * Built-in tool specs in registration order. Web and document tools close
 * over per-deployment config (API keys, the attachment store), so the caller
 * builds them.
 */
export function builtInToolSpecs(deps: {
  webTools: ReadonlyArray<ToolSpec>;
  documentTools: ReadonlyArray<ToolSpec>;
}): ToolSpec[] {
  return [
    ...memoryTools,
    ...deps.webTools,
    ...fileTools,
    ...coreMemoryTools,
    ...deps.documentTools,
    ...schedulingTools,
    ...pipelineTools,
    delegateCodingTool,
    registerSkillTool,
  ];
}
