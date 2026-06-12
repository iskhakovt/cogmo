/**
 * Pipeline compiler — free text → validated `PipelineDefinition`.
 *
 * Two validation layers, each with its own retry budget:
 * 1. `chatTyped` enforces `PipelineDefinitionSchema` structurally
 *    (jsonrepair + Zod-failure feedback, budget inside chatTyped).
 * 2. The deterministic pass (`validateDefinition`) enforces cross-field
 *    rules; its issues feed back to the model as a synthetic user turn,
 *    up to `MAX_VALIDATION_RETRIES` re-calls.
 *
 * The LLM never emits trusted output — everything it produces goes through
 * schema parse + deterministic checks before a definition can be stored
 * (design/pipelines.md → Core Decision).
 */

import { err, ok, type Result } from "neverthrow";
import type { LlmProvider } from "../../llm/provider.js";
import { chatTyped } from "../../llm/typed.js";
import type { Message } from "../../llm/types.js";
import { logger } from "../../logger.js";
import { type PipelineDefinition, PipelineDefinitionSchema } from "./types.js";
import { type ValidationContext, type ValidationIssue, validateDefinition } from "./validate.js";

const log = logger.child({ component: "pipeline.compile" });

/** Re-calls permitted when the deterministic pass rejects an otherwise schema-valid definition. */
export const MAX_VALIDATION_RETRIES = 2;

export interface CompileError {
  kind: "validation_failed";
  /** Issues from the final attempt — what the user needs to disambiguate. */
  issues: ReadonlyArray<ValidationIssue>;
}

export interface CompileDeps {
  provider: LlmProvider;
  model: string;
  validation: ValidationContext;
}

export interface CompileResultOk {
  definition: PipelineDefinition;
  /** Total deterministic-pass retries consumed (0 = first attempt was clean). */
  validationRetries: number;
}

/**
 * Compile the user's free-text pipeline description. Provider/protocol
 * errors and chatTyped's structural-retry exhaustion propagate as throws
 * (the tool layer reports them as tool errors); a definition that stays
 * deterministically invalid after the retry budget returns a structured
 * `validation_failed` so the caller can show the user what's ambiguous.
 */
export async function compilePipeline(
  deps: CompileDeps,
  args: { sourceText: string },
): Promise<Result<CompileResultOk, CompileError>> {
  const system = buildCompilerSystemPrompt(deps.validation);
  const messages: Message[] = [{ role: "user", content: args.sourceText }];

  let issues: ValidationIssue[] = [];
  for (let attempt = 0; attempt <= MAX_VALIDATION_RETRIES; attempt++) {
    const { data } = await chatTyped({
      provider: deps.provider,
      model: deps.model,
      system,
      messages,
      schema: PipelineDefinitionSchema,
      name: "pipeline_definition",
      repair: {},
    });

    issues = validateDefinition(data, deps.validation);
    if (issues.length === 0) {
      return ok({ definition: data, validationRetries: attempt });
    }

    log.debug(
      { attempt, issueCount: issues.length },
      "pipeline compile: deterministic validation failed",
    );
    messages.push(
      { role: "assistant", content: JSON.stringify(data) },
      {
        role: "user",
        content:
          "The definition is structurally valid but fails these checks:\n" +
          issues.map((i) => `- ${i.path}: ${i.message}`).join("\n") +
          "\n\nProduce a corrected definition that resolves every issue.",
      },
    );
  }

  return err({ kind: "validation_failed", issues });
}

function buildCompilerSystemPrompt(ctx: ValidationContext): string {
  const eventSourceNote =
    ctx.knownEventSources.length === 0
      ? "No external event sources exist yet — never emit `event` triggers or `wait` stages. Model 'wait for X' requests as a gate stage instead, and tell the user (via stage instructions) that true event waits arrive later."
      : `Known event sources: ${[...ctx.knownEventSources].sort().join(", ")}.`;

  return `You compile a user's free-text description of a multi-stage pipeline into a typed definition. The definition has two layers:

- The ENVELOPE — trigger, stage sequence, gates, timeouts, loop bounds, tool allowlists — is deterministic and frozen. Be conservative and explicit here.
- Each stage's INSTRUCTIONS stay as prose, interpreted by an agent at run time. Preserve the user's own words and intent; do not over-specify.

Rules:
- Stage ids and the pipeline name are kebab-case slugs derived from the content.
- Stage kinds: "agentic" (the agent works), "gate" (a human checkpoint — approval or discussion), "wait" (park on an external event).
- agentic and gate stages REQUIRE instructions. Tool allowlists and typed outputs belong on agentic stages only.
- Every gate and wait carries a timeout (ms-style: "30m", "3h", "3d", "2w" — nothing longer than a year) and an onTimeout action. Prefer {"kind":"remind","maxReminders":3,"finalAction":"abort"} for human gates unless the user says otherwise. Never leave a wait unbounded.
- "Repeat / iterate / until" requests compile to a loop on the LAST stage of the repeated span: backTo = first stage of the span, until = the user's exit condition as prose, maxIterations = the user's number or 5 if unstated. Loop spans must not nest or overlap.
- Triggers: "command" (a chat phrase) unless the user clearly describes a schedule ("every morning" → cron with a sensible timezone from context).
- Tool allowlists: only include tools from the available list, and only when the user implies restriction; omit otherwise. Available tools: ${[...ctx.availableTools].sort().join(", ") || "(none)"}.
- ${eventSourceNote}

When the user's description is ambiguous, choose the conservative reading (tighter gates, smaller loop bounds) — the user reviews a preview before anything activates.`;
}
