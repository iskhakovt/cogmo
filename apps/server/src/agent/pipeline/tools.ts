import { randomUUID } from "node:crypto";
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

To run an active pipeline, call \`start_pipeline\` when the user asks for it — by its trigger phrase or in their own words. The run continues in a new conversation of its own: tell the user it has started and that its stages and checkpoints will appear there.

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
        "Active. Command-triggered pipelines start when the user asks and you call " +
        "start_pipeline. Cron and event triggers, loops and wait stages are not runnable yet — " +
        "start_pipeline reports which features block a run.",
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

const startSchema = z.object({
  name: z.string().describe("Name of the active pipeline to run, as shown by list_pipelines."),
});

export const startPipelineTool: ToolSpec = defineTool({
  name: "start_pipeline",
  description:
    "Start a run of one of the user's active pipelines. Call when the user asks to run it — " +
    "by its trigger phrase or by describing it. The run proceeds stage by stage in a new " +
    "conversation of its own, pausing at checkpoints for the user's approval.",
  schema: startSchema,
  // Durable: opens a run, a conversation, and moves the user's sessions onto
  // it. The call's idempotency key makes a retry recover that run.
  durable: true,
  handler: async ({ name }, service, ctx) => {
    const pipelines = requirePipelines(service);
    // Outside a retrying context nothing re-executes this call, so a fresh
    // key carries no dedup obligation.
    const idempotencyKey =
      ctx !== undefined ? `start_pipeline:${ctx.idempotencyKey}` : randomUUID();
    const result = await pipelines.start({ name, idempotencyKey });
    if (result.isErr()) return renderError(result.error);
    const { runId, version, firstStage } = result.value;
    return JSON.stringify({
      ok: true,
      runId,
      name: result.value.name,
      version,
      firstStage,
      note:
        "The run has started in a new conversation, which the user's chat now points at. Tell " +
        "the user it is underway; its stage output and checkpoints will appear there.",
    });
  },
});

export const pipelineTools: ReadonlyArray<ToolSpec> = [
  definePipelineTool,
  activatePipelineTool,
  listPipelinesTool,
  startPipelineTool,
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
    case "not_active":
      return `Pipeline "${error.name}" has no active version. Use list_pipelines to check its name, and activate_pipeline only after the user confirms its preview.`;
    case "unsupported_features":
      return `Pipeline "${error.name}" can't run yet — it uses features the run engine doesn't support: ${error.features.join(", ")}. Tell the user; they can redefine it without those features.`;
    case "no_reachable_channel":
      return "No channel can reach the user for this run's checkpoints, so it was not started.";
    case "runs_unavailable":
      return "Pipeline runs aren't available in this context.";
  }
}
