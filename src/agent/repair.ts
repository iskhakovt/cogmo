/**
 * In-loop Class C repair classifier and budgets.
 *
 * The streaming agent loop consults {@link classifyOutcome} after each
 * iteration's stream drains (or throws). When the classifier returns a
 * `repair` outcome, the loop applies the per-subtype repair (continuation
 * prompt, non-streaming replay) and re-enters; on budget exhaustion or
 * an immediate-degrade subtype, the loop exits with a degraded result and
 * the orchestrator posts the user-facing apology.
 *
 * The repair *semantics* live here; the *budget bookkeeping* lives in the
 * loop (`runStreamingAgentLoop`) — one budget set per Inngest invocation.
 * See `design/agent-resilience.md` → Class C.
 */

import { ProviderProtocolError } from "../llm/errors.js";
import { RefusalError } from "../llm/fallback.js";
import type { ContentBlock, StopReason } from "../llm/types.js";

/**
 * Class C subtypes that the in-loop classifier handles.
 *
 * Tool-arg validation (Zod failures inside a tool handler) is **not** a
 * Class C subtype — it rides on the existing unbounded `is_error: true`
 * tool_result channel inside the loop (`loop.ts`). The design doc is
 * explicit that tool-arg feedback is capped only by
 * `DEFAULT_MAX_ITERATIONS`, not by the Class C budget.
 */
export type ClassCSubtype = "empty_end_turn" | "stream_truncation" | "refusal";

/**
 * Subset of {@link ClassCSubtype} that carries a per-turn repair budget.
 * Refusal is excluded — it's immediate-degrade with nothing to decrement.
 * Used to keep the `repair` arm of {@link TurnOutcome} narrow so a
 * `budgets[outcome.subtype]--` decrement is always sound.
 */
export type BudgetedSubtype = keyof RepairBudgets;

/**
 * Mutable budget tracker passed through the loop. Each repair attempt
 * decrements the matching counter; classify routes through `degrade` once
 * a counter reaches 0 for its subtype's repair-eligible cases. Refusal
 * has no entry — it's immediate-degrade with nothing to decrement.
 */
export interface RepairBudgets {
  empty_end_turn: number;
  stream_truncation: number;
}

/**
 * Per-subtype repair budget starting values. Tracked per turn (one Inngest
 * invocation = one budget set). Per-subtype rather than shared because the
 * subtypes have genuinely different failure dynamics — exhausting one
 * shouldn't lock out the other.
 *
 *  - `empty_end_turn: 1` — Anthropic's documented recovery is a single
 *    continuation nudge.
 *  - `stream_truncation: 1` — one non-streaming replay of the same turn.
 *
 * Refusal has no budget entry: the classifier degrades immediately and
 * the loop never decrements anything on the refusal path. If a future
 * "try refusal-recovery prompt" experiment wants a budget, it can re-add
 * the field deliberately with logic.
 */
export const INITIAL_BUDGETS: Readonly<RepairBudgets> = Object.freeze({
  empty_end_turn: 1,
  stream_truncation: 1,
});

export function freshBudgets(): RepairBudgets {
  return { ...INITIAL_BUDGETS };
}

/**
 * What `repairTurn` does for a given subtype.
 *
 *  - `continuation_prompt`: append a synthetic user turn to the in-memory
 *    history for the next iteration. Not persisted (synthetic / ephemeral,
 *    same convention as `validateHistory`-synthesized tool_results).
 *  - `stream_replay`: replay the just-failed turn with `stream: false`.
 *    The non-streaming response should complete the partial output.
 */
export type RepairInstructions =
  | { kind: "continuation_prompt"; text: string }
  | { kind: "stream_replay" };

/**
 * Classifier output.
 *
 *  - `ok`: stream is fine, the loop proceeds with the normal hasToolUse gate.
 *  - `repair`: the loop should apply the instructions, decrement the
 *    matching budget, and re-iterate.
 *  - `degrade`: the loop exits and the orchestrator posts the degraded
 *    reply. Every classifier `degrade` carries a `subtype` tag; the
 *    iteration-cap backstop bypasses the classifier entirely and is the
 *    only callsite that constructs a degraded result with `subtype: null`.
 */
export type TurnOutcome =
  | { kind: "ok" }
  | { kind: "repair"; subtype: BudgetedSubtype; instructions: RepairInstructions }
  | { kind: "degrade"; reason: string; subtype: ClassCSubtype };

/**
 * Classify the just-finished turn based on its drained content and
 * stop_reason. Runs at the post-stream hook point (after content blocks
 * are reconstructed, before the `hasToolUse` gate). Returns `ok` for the
 * normal path so the loop's existing flow continues unchanged.
 *
 * A second hook point exists post-`executeToolCalls`, before appending
 * tool results — but tool-arg validation feedback rides on the existing
 * unbounded `is_error: true` channel and is **not** a Class C subtype.
 * That hook intentionally has no repair triggers today.
 */
export function classifyPostStream(
  content: ReadonlyArray<ContentBlock>,
  stopReason: StopReason,
  budgets: RepairBudgets,
): TurnOutcome {
  if (stopReason === "refusal") {
    // Refusal is immediate-degrade — no budget consulted, no repair
    // attempt. Re-prompting the same model on policy is the wrong shape;
    // a fallback chain (future) would have to opt in explicitly.
    return {
      kind: "degrade",
      reason: "model returned a policy refusal",
      subtype: "refusal",
    };
  }

  if (stopReason === "end_turn" && content.length === 0) {
    if (budgets.empty_end_turn > 0) {
      return {
        kind: "repair",
        subtype: "empty_end_turn",
        instructions: {
          kind: "continuation_prompt",
          text: "Please complete your response.",
        },
      };
    }
    return {
      kind: "degrade",
      reason: "model returned an empty turn",
      subtype: "empty_end_turn",
    };
  }

  return { kind: "ok" };
}

/**
 * The non-`ok` arms of {@link TurnOutcome}, used as the return shape of
 * {@link classifyStreamError} — an error never produces an "ok" outcome,
 * so narrowing this in the caller is cleaner than re-checking `.kind`
 * against the full union.
 */
export type StreamErrorOutcome = Exclude<TurnOutcome, { kind: "ok" }>;

/**
 * Classify an error thrown out of the stream-drain section of an iteration.
 *
 *  - `ProviderProtocolError`: the streamed tool-arg JSON failed to parse
 *    even after `jsonrepair`. The design doc treats this as the
 *    `stream_truncation` subtype — a non-streaming replay often completes
 *    where the chunked stream did not.
 *  - `RefusalError`: a content-policy refusal raised at create-time
 *    (typically OpenAI's 400 + `content_policy_violation`). Immediate
 *    degrade, same as the `stop_reason: "refusal"` path.
 *
 * Returns `undefined` when the error is not a Class C signal — callers
 * must propagate it untouched (Class A / B handling lives in the
 * orchestrator and provider chain).
 */
export function classifyStreamError(
  err: unknown,
  budgets: RepairBudgets,
): StreamErrorOutcome | undefined {
  if (err instanceof ProviderProtocolError) {
    if (budgets.stream_truncation > 0) {
      return {
        kind: "repair",
        subtype: "stream_truncation",
        instructions: { kind: "stream_replay" },
      };
    }
    return {
      kind: "degrade",
      reason: "streamed tool-call arguments could not be parsed",
      subtype: "stream_truncation",
    };
  }
  if (err instanceof RefusalError) {
    return {
      kind: "degrade",
      reason: "model refused the request",
      subtype: "refusal",
    };
  }
  return undefined;
}

/**
 * The text the orchestrator shows the user when a turn ends via the
 * degraded off-ramp. Refusal carries a refusal-specific message; every
 * other subtype shares the same apology.
 */
export function degradedReplyText(subtype: ClassCSubtype | null): string {
  if (subtype === "refusal") {
    return "The model declined that request. Try rephrasing, or switch model with `/model`.";
  }
  return "I had trouble generating a clean response — the model returned an output I couldn't process. Could you rephrase or try again?";
}
