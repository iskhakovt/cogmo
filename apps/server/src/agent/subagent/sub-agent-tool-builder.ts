import { NonRetriableError } from "inngest";
import { z } from "zod";
import { resolveLimits } from "../../llm/models.js";
import {
  type LlmProviderResolver,
  ProviderConfigError,
  type ResolvedLlm,
} from "../../llm/resolver.js";
import type { ContentBlock } from "../../llm/types.js";
import type { SubAgent } from "../store/index.js";
import { defineTool, type ToolSpec } from "../tools.js";

/**
 * Tool-name namespace for sub-agents. Mirrors MCP's `mcp__<server>__<tool>` —
 * the prefix makes a collision with a built-in structurally impossible and
 * lets a profile opt into every sub-agent with a `subagent__*` glob in its
 * `tool_set`.
 */
export const SUBAGENT_TOOL_PREFIX = "subagent__";

/**
 * Valid sub-agent name shape — lowercase ASCII, letter-led, ≤32 chars. Keeps
 * `subagent__<name>` a legal tool name (`^[a-zA-Z0-9_-]{1,64}$`) and matches
 * the project's compartment / profile-class naming convention.
 */
export const SUB_AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function subAgentToolName(name: string): string {
  return `${SUBAGENT_TOOL_PREFIX}${name}`;
}

/**
 * Prompt guidance for the sub-agent tool family. Phrased conditionally so it
 * stays accurate whether or not the user has configured any sub-agents (a
 * fresh install has none) — it only describes behaviour for the case where
 * `subagent__*` tools are present in the turn's toolset.
 */
export const SUBAGENT_PROMPT_GUIDANCE = `When your tools include \`subagent__*\` specialists, you can delegate a self-contained subtask to one — useful for a model that is stronger at a specific skill (deep reasoning, long-form writing) or that you'd rather not run inline. Each specialist's tool description says when to reach for it. They have no memory, file, or conversation access and cannot call tools, so pass everything they need in \`task\` and \`context\`, then act on the text they return — deliver it, refine it, or feed it into another tool yourself.`;

const SubAgentInputSchema = z.object({
  task: z.string().min(1).describe("The self-contained subtask for the specialist to perform."),
  context: z
    .string()
    .optional()
    .describe(
      "Optional supporting context the specialist needs. It has no memory, file, or tool access — pass everything it requires here.",
    ),
});

/**
 * Build the per-turn sub-agent tools — one `subagent__<name>` tool per row.
 *
 * The handler resolves the row's model via the shared resolver and runs a
 * single completion with **no tools**: the specialist physically cannot call
 * tools (that's the point — it's for models good at a feature but unable to
 * tool-call). The orchestrator curates context in via `task`/`context` and
 * acts on the text out. `system_prompt` is sent only when set; null means a
 * pure model-as-tool whose per-call task carries all instruction.
 *
 * Returned specs are filtered by the active profile's `tool_set` globs in
 * `composeTurnTools`, so availability is per-profile with no extra mechanism.
 */
export function buildSubAgentTools(
  rows: ReadonlyArray<SubAgent>,
  resolveProvider: LlmProviderResolver,
): ToolSpec[] {
  return rows.map((row) =>
    defineTool({
      name: subAgentToolName(row.name),
      description: row.description,
      schema: SubAgentInputSchema,
      // Independent LLM call with no writes to our state — safe to fan out
      // when the orchestrator delegates to several specialists at once.
      parallelSafe: true,
      // No observable world-state change. Keeps the loop-pathology gate honest:
      // a turn that only delegates and never produces a reply isn't progress.
      sideEffectful: false,
      // Cap runaway delegation within a single turn.
      invocationBudget: 3,
      // One-shot and non-streaming, so the loop can wrap it in `step.run` — a
      // handle-message retry replays the cached result instead of re-billing
      // the specialist call.
      durable: true,
      handler: async (input) => {
        // Resolve the specialist's model. A ProviderConfigError is permanent —
        // the model's routing was removed after this sub-agent was created (the
        // sub_agents.model dangle). Rethrow as NonRetriableError: Inngest fails
        // the durable step on the first attempt (no retry burn on an error that
        // can't succeed) and the loop records a proper isError tool_result.
        // Transient resolve failures rethrow as-is, so the step retries them.
        // Mirrors `resolveOrFail` (handle-message.ts) — duplicated, not imported,
        // to avoid a handle-message → builder dependency cycle.
        let resolved: ResolvedLlm;
        try {
          resolved = await resolveProvider(row.model);
        } catch (err) {
          if (err instanceof ProviderConfigError) {
            throw new NonRetriableError(err.message, { cause: err });
          }
          throw err;
        }
        const { provider, limits } = resolved;
        const userText =
          input.context !== undefined && input.context.length > 0
            ? `${input.task}\n\nContext:\n${input.context}`
            : input.task;
        // No pre-send context-window guard: an oversized task+context surfaces
        // as a provider error → isError tool_result (degraded, not a crash).
        // A token check before the call is deferred (see todo → sub-agents v1).
        const response = await provider.chat({
          model: row.model,
          system: row.systemPrompt ?? "",
          messages: [{ role: "user", content: userText }],
          maxTokens: resolveLimits(row.model, limits).maxOutputTokens,
        });
        // Concatenate the text blocks verbatim — no trim — so exact output
        // fidelity (leading/trailing whitespace, formatting) survives.
        const text = response.content
          .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        // No text (the model emitted only thinking, refused, or stopped early)
        // is a failed delegation, not an empty answer — throw so the loop
        // records an isError tool_result, rather than handing the orchestrator
        // fabricated content it might surface to the user or reason over.
        if (text.length === 0) {
          throw new NonRetriableError(
            `sub-agent "${row.name}" (model ${row.model}) returned no text output`,
          );
        }
        // Same reasoning for a truncated answer, which the empty-text
        // check above cannot see: it wears the shape of a complete one, so
        // the orchestrator would reason over a sentence that stops
        // mid-clause. The message avoids quoting the cap requested above —
        // delegation is non-streaming, and a provider may hold it lower.
        if (response.stopReason === "max_tokens") {
          throw new NonRetriableError(
            `sub-agent "${row.name}" (model ${row.model}) ran out of output tokens and returned ` +
              `a truncated answer. Delegation is non-streaming, so the effective cap can be ` +
              `lower than the model's own limit — split the task or ask for a shorter answer.`,
          );
        }
        return text;
      },
    }),
  );
}
