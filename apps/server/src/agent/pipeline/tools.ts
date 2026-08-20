/**
 * Agent tools for user-defined pipelines. Dumb adapters over
 * `service.pipelines` — compile/cap/ownership logic lives in the service,
 * the tools parse Zod input and render results (and structured errors)
 * into LLM-readable text.
 */

import { z } from "zod";
import type { Service } from "../service.js";
import { defineTool, type ToolSpec } from "../tools.js";
import {
  MAX_SOURCE_TEXT_LENGTH,
  type PipelineSummary,
  type PipelinesError,
  type PipelinesService,
} from "./pipelines-service.js";

export const PIPELINES_PROMPT_GUIDANCE = `You can turn a user's described multi-stage workflow into a saved pipeline via \`define_pipeline\`. The flow is strictly two-step:
1. \`define_pipeline\` compiles their description and returns a preview. Show the preview to the user **verbatim** and ask whether to activate. Nothing runs yet.
2. Only after the user explicitly confirms, call \`activate_pipeline\`. Never activate without that confirmation; if they want changes, call \`define_pipeline\` again with the revised description (it creates a new version).

Pipelines are for repeatable multi-stage workflows with checkpoints ("draft a plan, wait for my approval, then implement"). For a one-shot reminder or scheduled prompt, use \`schedule_task\` instead.`;

const defineSchema = z.object({
  description: z
    .string()
    .min(20)
    .max(MAX_SOURCE_TEXT_LENGTH)
    .describe(
      "The user's pipeline description in their own words — stages, checkpoints, repetition, " +
        "trigger. Pass their intent faithfully; do not pre-structure it into steps yourself.",
    ),
});

const activateSchema = z.object({
  name: z.string().describe("Pipeline name as returned by define_pipeline or list_pipelines."),
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Specific version to activate. Omit for the latest."),
});

export const definePipelineTool: ToolSpec = defineTool({
  name: "define_pipeline",
  description:
    "Compile the user's free-text description of a multi-stage workflow into a saved pipeline " +
    "definition. Returns a preview of the compiled stages — show it to the user and get their " +
    "explicit confirmation before calling activate_pipeline. The definition is inert until " +
    "activated.",
  schema: defineSchema,
  // The compile is a billable multi-call LLM interaction — cache it across
  // Inngest retries so a crashed turn doesn't re-bill.
  durable: true,
  handler: async ({ description }, service) => {
    const pipelines = requirePipelines(service);
    const result = await pipelines.define({ sourceText: description });
    if (result.isErr()) return renderError(result.error);
    const { name, version, preview } = result.value;
    return JSON.stringify({
      ok: true,
      name,
      version,
      preview,
      nextStep:
        "Show the preview to the user verbatim and ask for confirmation. Call activate_pipeline " +
        "only after they explicitly confirm.",
    });
  },
});

export const activatePipelineTool: ToolSpec = defineTool({
  name: "activate_pipeline",
  description:
    "Activate a compiled pipeline definition after the user has confirmed its preview. " +
    "Activating a new version deactivates the previous one.",
  // Durable: flips pipeline activation state. Exactly-once per turn, not
  // once per step boundary after the call.
  durable: true,
  schema: activateSchema,
  handler: async (input, service) => {
    const pipelines = requirePipelines(service);
    const result = await pipelines.activate({
      name: input.name,
      ...(input.version !== undefined && { version: input.version }),
    });
    if (result.isErr()) return renderError(result.error);
    return JSON.stringify({
      ok: true,
      name: result.value.name,
      version: result.value.version,
      note:
        "Active. Pipeline execution is not implemented yet — the definition is saved and " +
        "activated, but runs will not start from any trigger until the run engine ships. " +
        "Tell the user this honestly if they ask when it will fire.",
    });
  },
});

export const listPipelinesTool: ToolSpec = defineTool({
  name: "list_pipelines",
  description: "List the user's pipelines with their active and latest versions.",
  schema: z.object({}),
  parallelSafe: true,
  sideEffectful: false,
  handler: async (_input, service) => {
    const pipelines = requirePipelines(service);
    const summaries = await pipelines.list();
    if (summaries.length === 0) return "No pipelines defined yet.";
    return JSON.stringify(summaries.map(renderSummary));
  },
});

export const pipelineTools: ReadonlyArray<ToolSpec> = [
  definePipelineTool,
  activatePipelineTool,
  listPipelinesTool,
];

/**
 * Excluded from stage tool-allowlist resolution: a pipeline run must not
 * be able to define or activate pipelines mid-run — that is a
 * self-modification surface the preview/confirm gate exists to prevent.
 * The exclusion is enforced where `availableTools` is assembled
 * (handle-message), so a compiled allowlist naming these fails the
 * deterministic validation pass.
 */
export const PIPELINE_TOOL_NAMES: ReadonlyArray<string> = pipelineTools.map((t) => t.name);

function requirePipelines(service: Service): PipelinesService {
  if (!service.pipelines) {
    throw new Error("Pipelines are unavailable in this context.");
  }
  return service.pipelines;
}

function renderSummary(summary: PipelineSummary): Record<string, unknown> {
  return {
    name: summary.name,
    activeVersion: summary.activeVersion,
    latestVersion: summary.latestVersion,
    stages: summary.stageCount,
    trigger: summary.trigger,
  };
}

function renderError(error: PipelinesError): string {
  switch (error.kind) {
    case "compile_failed":
      return (
        "Could not compile the pipeline — these points need disambiguation:\n" +
        error.issues.map((i) => `- ${i.path}: ${i.message}`).join("\n") +
        "\nAsk the user to clarify, then call define_pipeline again with the refined description."
      );
    case "source_too_long":
      return `Description is ${error.length} chars; the limit is ${error.maxLength}. Summarize the workflow and retry.`;
    case "definition_cap_exceeded":
      return `Definition cap reached (${error.current}/${error.limit}). The user must remove pipelines before defining more.`;
    case "not_found":
      return `No pipeline named "${error.name}"${error.version !== undefined ? ` with version ${error.version}` : ""}. Use list_pipelines to see what exists.`;
  }
}
