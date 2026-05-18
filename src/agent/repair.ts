/**
 * In-loop repair classifier and budgets (Class C model misbehavior) +
 * fingerprint helper for Class D loop-pathology detection.
 *
 * The streaming agent loop consults {@link classifyPostStream} /
 * {@link classifyStreamError} after each iteration's stream drains (or
 * throws). When the classifier returns a `repair` outcome, the loop
 * applies the per-subtype repair (continuation prompt, non-streaming
 * replay) and re-enters; on budget exhaustion or an immediate-degrade
 * subtype, the loop exits with a degraded result and the orchestrator
 * posts the user-facing apology.
 *
 * For Class D, {@link computeIterationFingerprint} produces a stable hash
 * over an iteration's tool calls (tool name + canonical-JSON args). The
 * loop maintains consecutive + cumulative counters keyed by this hash and
 * trips into the same degraded off-ramp when the model keeps issuing the
 * same side-effect-free tool calls.
 *
 * The repair *semantics* live here; the *budget bookkeeping* and the
 * fingerprint counters live in the loop (`runStreamingAgentLoop`) — one
 * budget set / counter set per Inngest invocation. See
 * `design/agent-resilience.md` → Class C / Class D.
 */

import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import * as R from "remeda";
import { ProviderProtocolError } from "../llm/errors.js";
import { RefusalError } from "../llm/fallback.js";
import type { ContentBlock, Message, StopReason, ToolUseBlock } from "../llm/types.js";

/**
 * Subtypes the in-loop classifier emits on the degraded off-ramp.
 *
 *  - `empty_end_turn`, `stream_truncation`, `refusal` — Class C model
 *    misbehavior subtypes ({@link classifyPostStream},
 *    {@link classifyStreamError}).
 *  - `stuck_loop`, `stuck_loop_cumulative` — Class D loop-pathology trips
 *    fired from the loop body when {@link computeIterationFingerprint}
 *    repeats without an observable side effect.
 *
 * Tool-arg validation (Zod failures inside a tool handler) is **not** a
 * subtype — it rides on the existing unbounded `is_error: true`
 * tool_result channel inside the loop (`loop.ts`). The design doc is
 * explicit that tool-arg feedback is capped only by
 * `DEFAULT_MAX_ITERATIONS`, not by the Class C budget.
 */
export type RepairSubtype =
  | "empty_end_turn"
  | "stream_truncation"
  | "refusal"
  | "stuck_loop"
  | "stuck_loop_cumulative"
  | "volume_cluster";

/**
 * Subtypes that can land on the degraded off-ramp. `volume_cluster` is a
 * repair only — the loop continues, no `conversation/degraded` event,
 * no entry on {@link AgentLoopResult.degraded.subtype}. Narrowing here
 * keeps the event schema and the result type aligned to what actually
 * can show up at the degrade boundary.
 */
export type DegradeSubtype = Exclude<RepairSubtype, "volume_cluster">;

/**
 * Subset of {@link RepairSubtype} that carries a per-turn repair budget.
 * Refusal is excluded — it's immediate-degrade with nothing to decrement.
 * Class D subtypes are excluded — they're trip-only (loop-pathology), no
 * repair attempt to budget against. Used to keep the `repair` arm of
 * {@link TurnOutcome} narrow so a `budgets[outcome.subtype]--` decrement
 * is always sound.
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
  | { kind: "degrade"; reason: string; subtype: DegradeSubtype };

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
export function degradedReplyText(subtype: DegradeSubtype | null): string {
  if (subtype === "refusal") {
    return "The model declined that request. Try rephrasing, or switch model with `/model`.";
  }
  return "I had trouble generating a clean response — the model returned an output I couldn't process. Could you rephrase or try again?";
}

/**
 * Class D trip thresholds. Two layered triggers per the design:
 *
 *  - `consecutive`: three consecutive side-effect-free iterations with
 *    the same fingerprint. Catches a model emitting the same
 *    read-only tool call back-to-back.
 *  - `cumulative`: same fingerprint accumulates five side-effect-free
 *    occurrences total across the run, regardless of consecutiveness.
 *    Catches alternating patterns (`A, B, A, B, A`) the consecutive
 *    rule alone would miss.
 *
 * `DEFAULT_MAX_ITERATIONS = 20` in the loop stays as the backstop.
 * See design/agent-resilience.md → Class D.
 */
export const CLASS_D_CONSECUTIVE_LIMIT = 3;
export const CLASS_D_CUMULATIVE_LIMIT = 5;

/**
 * Decide which (if any) Class D subtype trips given the current
 * side-effect-free counters for one fingerprint. Returns `null` when
 * neither threshold is reached so the caller proceeds with the next
 * LLM iteration.
 *
 * Consecutive is checked first because it's the tighter trigger — three
 * consecutive matches will also have a cumulative count >= 3, but the
 * subtype tag distinguishes the failure shape the model exhibited and
 * the failure-reflector buckets them separately.
 */
export function classifyClassDTrip(
  consecutiveCount: number,
  cumulativeCount: number,
): "stuck_loop" | "stuck_loop_cumulative" | null {
  if (consecutiveCount >= CLASS_D_CONSECUTIVE_LIMIT) return "stuck_loop";
  if (cumulativeCount >= CLASS_D_CUMULATIVE_LIMIT) return "stuck_loop_cumulative";
  return null;
}

/**
 * Compute the Class D loop-pathology fingerprint for one iteration's
 * tool calls.
 *
 * Hash structure: `sha256` over the sorted list of `(name, sha256(args))`
 * pairs. The inner list is sorted by `(name, args-hash)` so a model that
 * varies the emission order of parallel-safe tool calls between
 * iterations — `[search, fetch]` then `[fetch, search]` with otherwise
 * identical args — still produces the same fingerprint; the fingerprint
 * asks "did this iteration do the same work as the previous one?" and
 * emission order isn't part of the work.
 *
 * Args are stringified through the `canonicalize` library (RFC 8785 JSON
 * Canonicalization Scheme) so object key order (`{a: 1, b: 2}` vs
 * `{b: 2, a: 1}`) doesn't move the hash.
 *
 * Assistant text is deliberately **excluded** — text prefixes are
 * brittle (timestamps, hedging preambles, emoji noise), so two iterations
 * doing identical redundant tool work but emitted with different openers
 * would otherwise not match. The side-effect gate in the loop already
 * protects pure-text replies, so the text component would only add false
 * negatives.
 *
 * Returns `null` when the iteration produced no tool calls — a text-only
 * iteration exits the loop through the `!hasToolUse` gate and has no
 * fingerprint to compare against.
 *
 * See `design/agent-resilience.md` → Class D.
 */
export function computeIterationFingerprint(toolUses: ReadonlyArray<ToolUseBlock>): string | null {
  if (toolUses.length === 0) return null;
  const pairs = toolUses.map((b) => `${b.name}:${sha256(canonicalJson(b.input))}`).sort();
  return sha256(pairs.join("|"));
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Stable canonical-JSON encoding for fingerprint hashing. Wraps the
 * `canonicalize` library (RFC 8785 JSON Canonicalization Scheme) — sorted
 * object keys at every depth, arrays preserve order. Tool arguments are
 * JSON-compatible by construction (they flow through the
 * `tool_use.input` field, which providers serialize as JSON), so RFC 8785
 * coverage matches what the LLM emits. The library returns `undefined`
 * only for top-level `undefined` / function / symbol input — values that
 * cannot appear in a parsed `tool_use.input`. Throwing on `undefined`
 * surfaces such a bug instead of silently collapsing every offending
 * iteration to `sha256("")` and falsely tripping Class D.
 */
function canonicalJson(value: unknown): string {
  const encoded = canonicalize(value);
  if (encoded === undefined) {
    throw new Error(
      "canonicalJson: input is not JSON-representable (undefined / function / symbol)",
    );
  }
  return encoded;
}

/**
 * Tally of prior same-tool outcomes within one turn, used to shape the
 * volume-cluster nudge. Counts are over `tool_result` blocks already
 * present in the iteration's accumulated message array — i.e. handlers
 * that ran to completion or errored. `tool_use` blocks without a matching
 * `tool_result` (the model-in-flight case) are ignored.
 */
export interface ToolOutcomeMix {
  successes: number;
  failures: number;
  /** First-line summaries of failure tool_result content, deduped. */
  failureReasons: string[];
}

/**
 * Count how many times the model has emitted a `tool_use` block targeting
 * `toolName` within the slice `messages[fromIdx..]` (the current turn's
 * accumulated array). Counts assistant-message `tool_use` blocks; ignores
 * `tool_result`s. Used for the count carried in the nudge text — the
 * model thinks in "calls," not "batches," so the nudge tells it how many
 * blocks it has emitted.
 *
 * Derives from the message array rather than a separate counter — Inngest
 * function replay re-executes everything outside `step.run` from the top,
 * so a closure-held counter would silently reset mid-turn. Scanning the
 * already-built message array reflects the actual current state regardless
 * of replay topology. See `design/agent-resilience.md` →
 * "Implementation note: derive, don't store".
 */
export function countToolInvocations(
  toolName: string,
  messages: ReadonlyArray<Message>,
  fromIdx: number,
): number {
  return messages
    .slice(fromIdx)
    .flatMap((msg) => (msg.role === "assistant" && Array.isArray(msg.content) ? msg.content : []))
    .filter((b) => b.type === "tool_use" && b.name === toolName).length;
}

/**
 * Count distinct *iterations* (assistant messages) within
 * `messages[fromIdx..]` that emitted at least one `tool_use` block for
 * `toolName`. This is the **batch** count — the unit the volume-cluster
 * budget operates on.
 *
 * Per-iteration counting (not per-block) is the design choice that
 * distinguishes "model is stuck re-deciding to call T" (multiple
 * iterations) from "model decided to parallel-call T N times in one
 * shot" (one iteration, N blocks). A user requesting "generate 10
 * images" usually produces either (a) one iteration with 10 parallel
 * blocks → one batch, admitted, or (b) ten sequential iterations →
 * ten batches, intercepted at the budget. The cluster trigger targets
 * the across-iteration decision loop, not the within-iteration
 * parallelism.
 *
 * See `design/agent-resilience.md` → Volume cluster trigger.
 */
export function countToolInvocationBatches(
  toolName: string,
  messages: ReadonlyArray<Message>,
  fromIdx: number,
): number {
  return messages
    .slice(fromIdx)
    .filter(
      (msg) =>
        msg.role === "assistant" &&
        Array.isArray(msg.content) &&
        msg.content.some((b) => b.type === "tool_use" && b.name === toolName),
    ).length;
}

/**
 * Summarize prior tool_results for `toolName` in the turn slice
 * `messages[fromIdx..]`. Walks all user-message tool_result blocks and
 * pairs them back to the matching tool_use by id to filter by tool name.
 * Each failure's first non-empty line (capped at 120 chars) is captured
 * as a deduped reason for the nudge text.
 */
export function summarizeToolOutcomes(
  toolName: string,
  messages: ReadonlyArray<Message>,
  fromIdx: number,
): ToolOutcomeMix {
  const slice = messages.slice(fromIdx);

  const idsForTool = new Set(
    slice
      .flatMap((msg) => (msg.role === "assistant" && Array.isArray(msg.content) ? msg.content : []))
      .filter((b): b is ToolUseBlock => b.type === "tool_use" && b.name === toolName)
      .map((b) => b.id),
  );

  const matchingResults = slice
    .flatMap((msg) => (msg.role === "user" && Array.isArray(msg.content) ? msg.content : []))
    .filter(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result" && idsForTool.has(b.toolUseId),
    )
    // Exclude this tool's own prior volume-cluster nudges. The cluster
    // trigger lands a synthetic `isError: true` tool_result whose content
    // begins with `volumeClusterNudgePrefix(toolName)`; without this
    // filter, a model that ignores one nudge and emits another batch
    // would see the prior nudge quoted as a "failure reason" in the next
    // nudge (recursive impurity). The fingerprint still degrades that
    // scenario quickly, but the interim nudge would be confusing.
    .filter((b) => !isVolumeClusterNudge(toolName, b.content));

  const failures = matchingResults.filter((r) => r.isError === true);
  const failureReasons = R.unique(
    failures.map((r) => firstLineSummary(r.content)).filter((s): s is string => s !== null),
  );

  return {
    successes: matchingResults.length - failures.length,
    failures: failures.length,
    failureReasons,
  };
}

function firstLineSummary(content: unknown): string | null {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((b) =>
              typeof b === "object" && b !== null && "text" in b && typeof b.text === "string"
                ? b.text
                : "",
            )
            .join("\n")
        : "";
  const trimmed =
    raw
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "";
  if (trimmed.length === 0) return null;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

/**
 * Common prefix every volume-cluster nudge starts with for a given
 * tool. Shared between {@link formatVolumeClusterContent} (the builder)
 * and {@link summarizeToolOutcomes} (the filter that excludes prior
 * synthetic nudges of this same tool from outcome counts). Kept as one
 * function so the two callsites can't drift apart silently — if the
 * nudge format ever changes its leading clause, both ends update
 * together.
 */
function volumeClusterNudgePrefix(toolName: string): string {
  return `You have called \`${toolName}\` `;
}

function isVolumeClusterNudge(toolName: string, content: unknown): boolean {
  return typeof content === "string" && content.startsWith(volumeClusterNudgePrefix(toolName));
}

/**
 * Build the synthetic `is_error: true` `tool_result` content the loop
 * appends when the volume-cluster budget for `toolName` exhausts.
 * Branches the text on outcome mix — all-fail, mixed, all-success — so
 * the model gets actionable guidance instead of a generic stop signal.
 */
export function formatVolumeClusterContent(
  toolName: string,
  count: number,
  outcomes: ToolOutcomeMix,
): string {
  const { successes, failures, failureReasons } = outcomes;
  const reasonText = failureReasons.length > 0 ? ` Reasons: ${failureReasons.join("; ")}.` : "";
  const prefix = volumeClusterNudgePrefix(toolName);
  const stopRule =
    `Do NOT call \`${toolName}\` again this turn. ` +
    "Either reply to the user with what you have, ask a clarifying question, or use a different tool.";
  if (failures > 0 && successes === 0) {
    return (
      `${prefix}${count} times this turn and every attempt failed.${reasonText} ` + `${stopRule}`
    );
  }
  if (successes > 0 && failures === 0) {
    return `${prefix}${count} times this turn — ${successes} succeeded. ` + `${stopRule}`;
  }
  return (
    `${prefix}${count} times this turn — ${successes} succeeded, ${failures} failed.${reasonText} ` +
    `${stopRule}`
  );
}

/**
 * Decide whether a single tool_use block trips the volume-cluster budget
 * for its tool, given the prior+in-iteration count of same-tool blocks
 * already emitted this turn. Returns `null` when the budget is not yet
 * exhausted — the caller proceeds with normal handler dispatch.
 *
 * The trip count semantic is "tool_use blocks the model produced for T
 * this turn so far, including the one being decided." A budget of `B`
 * means the first `B` calls execute; the `(B+1)`th and beyond are
 * intercepted.
 */
export function classifyVolumeCluster(
  count: number,
  budget: number,
): { kind: "intercept"; count: number } | null {
  if (count > budget) return { kind: "intercept", count };
  return null;
}
