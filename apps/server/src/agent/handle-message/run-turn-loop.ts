import type { Logger } from "pino";
import { isRetriableProviderError } from "../../llm/fallback.js";
import type { Message, StreamEvent } from "../../llm/types.js";
import { type DeliveryHandle, pushOrThrow } from "../../transport/delivery-router.js";
import type { AgentLoopResult, StepRunner, StreamingAgentLoopParams } from "../loop.js";
import { synthesizeDegradedReply } from "../repair.js";
import { computeRetraction } from "../retraction.js";
import type { Service } from "../service.js";
import type { ToolRegistry } from "../tools.js";
import { turnCacheIntent } from "../turn-cache-intent.js";
import { asNonRetriable } from "../turn-step-runner.js";
import type { TurnModel } from "./resolve-turn-model.js";
import type { TurnSteps } from "./turn-steps.js";

export interface RunTurnLoopArgs {
  conversationId: string;
  turnModel: TurnModel;
  systemPrompt: string;
  messages: Message[];
  tools: ToolRegistry;
  service: Service;
  delivery: DeliveryHandle;
  /** The batch's low-water mark (`batchCursors`); empty only for an empty batch. */
  firstInboundId: string;
  turnLogger: Logger;
}

export interface TurnLoopOutcome {
  /** The loop's result, a degraded turn's apology appended. */
  result: AgentLoopResult;
  /** Sessions whose stream failed at finish; the reply goes to them again once persisted. */
  unstreamed: ReadonlyArray<string>;
}

/**
 * Run the agent loop, streaming to the delivery handle, and close the stream.
 * A loop failure aborts the stream and rethrows, translated into Inngest's
 * retry decision.
 *
 * Steps, in order: the loop's `llm-iter<N>` / `tool-iter<N>-<P>` / … steps,
 * `degraded-reply` (when the loop degraded), `finish-stream`.
 */
export async function runTurnLoop(
  step: TurnSteps,
  stepRun: StepRunner,
  runStreamingAgentLoop: (params: StreamingAgentLoopParams) => Promise<AgentLoopResult>,
  args: RunTurnLoopArgs,
): Promise<TurnLoopOutcome> {
  const { turnModel, delivery, turnLogger, firstInboundId } = args;
  try {
    const looped = await runStreamingAgentLoop({
      provider: turnModel.provider,
      model: turnModel.model,
      systemPrompt: args.systemPrompt,
      messages: args.messages,
      tools: args.tools,
      service: args.service,
      // The number `computeBudget` reserved for output when it sized
      // the input budget (`resolveTurnModel`); reasoning shares it on models that
      // think by default. That reservation covers one iteration while
      // the loop caps every one, so a long tool-using turn can still
      // outgrow the window and degrade to `context_overflow`.
      maxTokens: turnModel.limits.maxOutputTokens,
      onEvent: (event: StreamEvent) => pushOrThrow(delivery, event),
      // Durable boundaries inside the loop: each streaming LLM
      // iteration runs in a `llm-iter<N>` step (tokens reach the
      // delivery layer live from inside the step body; a memoized
      // replay returns the cached iteration outcome without calling
      // the provider or re-emitting), and each `durable: true` tool
      // handler runs in a `tool-iter<N>-<P>` step. Handlers execute
      // *between* stream events, so wrapping preserves event
      // ordering. See design/crash-recovery.md → Durable LLM
      // iterations / Per-tool durability.
      stepRun,
      // Turn token for per-tool-call idempotency keys: the batch's
      // low-water mark, which identifies this turn's input and survives
      // re-invocations, function retries and re-deliveries alike. Empty
      // only for a turn with no inbound rows, which has nothing for a
      // tool to duplicate. (Not `triggerInboundId`, which a debounce
      // re-fire moves — see `batchCursors`.)
      ...(firstInboundId !== "" && { turnKey: firstInboundId }),
      cache: turnCacheIntent(args.conversationId, "chat"),
      clearToolResults: turnModel.clearToolResults,
      turnLogger,
    });
    const result = looped.degraded
      ? await withDegradedReply(step, looped, looped.degraded, args)
      : looped;
    // A step, so the sessions whose stream failed are known on every
    // later invocation. Such a stream may have shown the user nothing:
    // append-only mode writes only at chunk boundaries and at finish. A
    // retry of the turn wouldn't help, since replayed iterations re-emit
    // nothing, so the reply reaches those sessions through batch delivery
    // once it is persisted.
    const unstreamed = await step.run("finish-stream", async () => {
      const finished = await delivery.finish();
      if (finished.isOk()) return [];
      turnLogger.warn({ failures: finished.error.failures }, "stream delivery failed at finish");
      return finished.error.failures.map((failure) => failure.sessionId);
    });
    return { result, unstreamed };
  } catch (err) {
    // The loop's error decides the retry, so a failed abort is only logged.
    const aborted = await delivery.abort(err instanceof Error ? err.message : "Unknown error");
    if (aborted.isErr()) {
      turnLogger.warn({ err: aborted.error }, "stream delivery failed at abort");
    }
    // Translate provider classification into Inngest's retry decision.
    // 4xx that aren't 408/425/429 are deterministic client errors — the
    // same payload will fail every retry. Wrap in NonRetriableError so
    // Inngest fails the run on the first attempt instead of burning
    // ~6 minutes on retries before the onFailure handler can notify the
    // user. See design/crash-recovery.md.
    if (!isRetriableProviderError(err)) {
      throw asNonRetriable(err);
    }
    // Never wrap the error on this rethrow path. A permanently-failed
    // step surfaces here as Inngest's StepError (no `status`, so it
    // classifies as "retriable" above), and the engine's non-retriable
    // detection relies on the rethrown object keeping its identity and
    // serialized name — wrapping it would silently re-enable function
    // retries that instantly replay the memoized rejection.
    throw err;
  }
}

/**
 * Class C / D degraded off-ramp. The loop exited because a repair budget
 * exhausted (or an immediate-degrade subtype tripped); the user-facing apology
 * is appended here so the streamed reply closes with a coherent message rather
 * than silence. See design/agent-resilience.md → Degraded reply.
 *
 * Step: `degraded-reply`.
 */
async function withDegradedReply(
  step: TurnSteps,
  result: AgentLoopResult,
  degraded: NonNullable<AgentLoopResult["degraded"]>,
  args: Pick<RunTurnLoopArgs, "turnModel" | "delivery" | "turnLogger">,
): Promise<AgentLoopResult> {
  const { turnModel, delivery, turnLogger } = args;
  // Retraction computed OUTSIDE the step from `result.streamed` —
  // the loop derives that ledger from its durable iteration
  // outcomes, so it is identical on every invocation (a ledger of
  // live emissions would be empty on a replay whose iterations all
  // came from the step cache).
  const retraction = computeRetraction(result.streamed, result.newMessages, turnLogger);
  // One step owns the whole user-visible off-ramp: the tools-free
  // synthesis LLM call plus the retract/apology pushes. The
  // synthesis is billable and the pushes append to the user's live
  // message, so both must fire exactly once across the persist /
  // delivery / notify boundaries that follow — in the bare body
  // they would re-fire on every subsequent re-invocation. The
  // step returns the apology text, so replays persist the same
  // words the user saw. Plain `step.run`, not the `stepRun`
  // wrapper: synthesizeDegradedReply swallows provider failures
  // into the fixed fallback string internally, so no 4xx can
  // escape this body — the only escapable errors are delivery
  // pushes, which should keep normal step-retry semantics.
  const apology = await step.run("degraded-reply", async () => {
    // One tools-free LLM call summarizes the failure in
    // user-facing terms (what was attempted, what went wrong, one
    // next step). Falls through to the fixed string on any
    // synthesis failure (timeout, refusal, provider outage). See
    // design/agent-resilience.md → Tools-free synthesis on
    // degrade.
    const { text } = await synthesizeDegradedReply({
      provider: turnModel.provider,
      model: result.model,
      messages: result.messages,
      reason: degraded.reason,
      subtype: degraded.subtype,
      clearToolResults: turnModel.clearToolResults,
      log: turnLogger,
    });
    // Retract first. Output streamed before the degrade fired is
    // already on the user's screen (Telegram edits the live
    // message every ~500ms; the web adapter forwards every delta
    // as an SSE frame), and the loop drops the triggering
    // iteration from `newMessages` — so appending the apology to
    // it would leave the user reading a truncated fragment welded
    // to an apology that history doesn't contain. The retraction
    // names that iteration's output and nothing else: text and
    // tool calls from earlier iterations are persisted, so they
    // stay. Nothing to retract (nothing streamed, or an
    // iteration-cap degrade that persists every iteration) means
    // no event at all.
    if (retraction) {
      await pushOrThrow(delivery, { type: "retract", ...retraction });
    }
    await pushOrThrow(delivery, { type: "text_delta", text });
    return text;
  });
  return {
    ...result,
    text: apology,
    newMessages: [
      ...result.newMessages,
      { role: "assistant", content: [{ type: "text", text: apology }] },
    ],
  };
}
