import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Logger } from "pino";
import * as R from "remeda";
import type { LlmProvider } from "../llm/provider.js";
import type {
  ContentBlock,
  Message,
  StopReason,
  StreamEvent,
  TextBlock,
  ToolUseBlock,
} from "../llm/types.js";
import { logger } from "../logger.js";
import { agentIterations } from "../metrics.js";
import { validateHistory } from "./history-invariants.js";
import {
  type ClassCSubtype,
  classifyPostStream,
  classifyStreamError,
  freshBudgets,
  type RepairBudgets,
} from "./repair.js";
import type { Service } from "./service.js";
import type { ToolRegistry, ToolSpec } from "./tools.js";

const tracer = trace.getTracer("cogmo.agent");

/**
 * Wraps a single tool-handler execution in a durable boundary (Inngest
 * `step.run`). When provided to the agent loop, tools with `spec.durable ===
 * true` run inside this wrapper, so their result is cached exactly-once across
 * retries. Handler errors propagate (Inngest per-step retries fire first,
 * then the error bubbles up).
 *
 * Injected rather than depending on Inngest's `step` directly — keeps the
 * loop testable without an Inngest context. When undefined, all tools run
 * directly regardless of their `durable` flag.
 *
 * Narrowed to `Promise<string>` to match `ToolHandler` (the only caller) — this
 * also matches Inngest's `step.run<Promise<string>>` exactly, since
 * `Jsonify<string> === string`.
 */
export type StepRunner = (id: string, fn: () => Promise<string>) => Promise<string>;

export interface AgentLoopParams {
  provider: LlmProvider;
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolRegistry;
  service: Service;
  maxIterations?: number;
  /**
   * Optional durability wrapper for tool handlers. See `StepRunner`.
   * When provided, tools with `spec.durable === true` run inside the wrapper
   * with step id `tool-<name>-<toolUseId>` (unique per LLM-issued tool call).
   */
  stepRun?: StepRunner;
  /**
   * Per-invocation child logger with `runId` + `conversationId` bound. When
   * provided, all per-turn log emissions inside the loop route through it so
   * downstream consumers can join structured logs to `conversation/degraded`
   * / `conversation/errored` events by `runId` + `conversationId` without
   * per-emission field stuffing. Optional only because some tests bypass it;
   * production wiring (`handle-message`) always provides it.
   */
  turnLogger?: Logger;
}

export interface AgentLoopResult {
  /** Final assistant text response */
  text: string;
  /** Full message history including tool calls/results */
  messages: Message[];
  /** Messages produced this invocation (intermediate tool turns + final assistant). */
  newMessages: Message[];
  /** Aggregated usage across all LLM calls */
  usage: { inputTokens: number; outputTokens: number };
  /** Which model was used */
  model: string;
  /** Number of LLM calls made */
  iterations: number;
  /**
   * Class C / D degraded off-ramp. When present, the loop exited because a
   * repair budget exhausted (or a subtype was immediate-degrade) — the
   * orchestrator posts a system-generated apology as the final assistant
   * message rather than `text`. `text` is `""` and `newMessages` carries
   * only the successfully completed intermediate iterations (the failing
   * iteration's content is NOT included; synthetic continuation prompts
   * are NOT included). See design/agent-resilience.md → Degraded reply.
   *
   * Backstops without a Class C tag (today: the iteration-cap) set
   * `subtype: null`. PR 6 will add `stuck_loop` / `stuck_loop_cumulative`
   * variants.
   */
  degraded?: { reason: string; subtype: ClassCSubtype | null };
}

const DEFAULT_MAX_ITERATIONS = 20;

/**
 * Run the history invariant validator and log any repairs.
 *
 * Defensive pre-flight: even with the loop's content-driven flow control
 * (no orphan tool_use is produced this turn), historical bugs could have
 * left orphans in the DB that any future turn would re-load. The validator
 * synthesizes error tool_results / drops strays so the request always
 * satisfies the API contract; repairs are logged so we can see whether
 * stale state is still showing up.
 */
function sanitizeHistory(messages: ReadonlyArray<Message>, log: Logger): Message[] {
  const { messages: repaired, repairs } = validateHistory(messages);
  if (repairs.length > 0) {
    log.warn({ repairCount: repairs.length, repairs }, "agent loop history invariants repaired");
  }
  return repaired;
}

/**
 * Clear thinking content from all assistant messages except the most recent.
 *
 * Anthropic requires thinking blocks in history but the content is only useful
 * for the model's immediate next response. Replacing with empty string preserves
 * the block structure while freeing tokens.
 */
export function clearOldThinking(messages: ReadonlyArray<Message>): Message[] {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  return messages.map((msg, idx) => {
    if (msg.role !== "assistant" || idx === lastAssistantIdx) return msg;
    if (typeof msg.content === "string") return msg;

    const hasThinking = msg.content.some((b) => b.type === "thinking");
    if (!hasThinking) return msg;

    return {
      ...msg,
      content: msg.content.map((b) => (b.type === "thinking" ? { ...b, thinking: "" } : b)),
    };
  });
}

/**
 * Run the agentic loop: call LLM → execute tools → repeat until done.
 *
 * Each iteration calls the LLM. If the response contains tool_use blocks,
 * the tools are executed and results appended. The loop continues until
 * the LLM returns end_turn or max_tokens, or we hit the iteration limit.
 */
export async function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult> {
  const {
    provider,
    model,
    systemPrompt,
    tools,
    service,
    stepRun,
    maxIterations = DEFAULT_MAX_ITERATIONS,
  } = params;
  const log = params.turnLogger ?? logger;
  const messages = clearOldThinking(sanitizeHistory(params.messages, log));
  const initialLength = messages.length;
  const toolDefs = tools.definitions();
  const totalUsage = { inputTokens: 0, outputTokens: 0 };
  let iterations = 0;
  let finalModel = model;

  while (iterations < maxIterations) {
    iterations++;

    const chatParams: Parameters<LlmProvider["chat"]>[0] = {
      model,
      system: systemPrompt,
      messages,
    };
    if (toolDefs.length > 0) {
      chatParams.tools = toolDefs;
    }
    const response = await provider.chat(chatParams);

    finalModel = response.model;
    totalUsage.inputTokens += response.usage.inputTokens;
    totalUsage.outputTokens += response.usage.outputTokens;

    // Append assistant response
    messages.push({ role: "assistant", content: response.content });

    // Drive flow on content, not `stop_reason`. Models occasionally return a
    // tool_use block alongside `stop_reason: "end_turn"` / `"max_tokens"`; if
    // we keyed off `stopReason` we'd return without executing the tool and
    // persist an orphan tool_use that breaks every subsequent turn. The
    // Anthropic contract is "every tool_use must be answered by a
    // tool_result" — content presence is the only safe gate.
    const hasToolUse = response.content.some((b) => b.type === "tool_use");
    if (!hasToolUse) {
      return buildResult(messages, initialLength, [], totalUsage, finalModel, iterations);
    }

    // Execute tool calls and append results
    const toolResults = await executeToolCalls(response.content, tools, service, stepRun);
    messages.push({ role: "user", content: toolResults });

    log.debug({ iteration: iterations, toolCalls: toolResults.length }, "tool round complete");
  }

  log.warn({ maxIterations }, "agent loop hit iteration limit");
  return buildResult(messages, initialLength, [], totalUsage, finalModel, iterations);
}

interface PlannedCall {
  block: ToolUseBlock;
  spec: ToolSpec | null;
}

// Unknown tools short-circuit to an error result with no side effects, so
// they coalesce with safe runs.
function isSafeCall(entry: PlannedCall): boolean {
  return entry.spec === null || entry.spec.parallelSafe === true;
}

async function executeToolCalls(
  content: ContentBlock[],
  tools: ToolRegistry,
  service: Service,
  stepRun: StepRunner | undefined,
): Promise<ContentBlock[]> {
  const toolUseBlocks = content.filter((b): b is ToolUseBlock => b.type === "tool_use");
  if (toolUseBlocks.length === 0) return [];

  const planned: PlannedCall[] = toolUseBlocks.map((block) => ({
    block,
    spec: tools.get(block.name) ?? null,
  }));

  // Coalesce consecutive safe entries; unsafe entries stay as singletons so
  // [write_file(p), write_file(p)] still runs serially.
  const groups = R.reduce(
    planned,
    (acc, entry) => {
      const tail = acc.at(-1);
      // biome-ignore lint/style/noNonNullAssertion: tail non-empty by construction
      if (isSafeCall(entry) && tail !== undefined && isSafeCall(tail[0]!)) {
        tail.push(entry);
      } else {
        acc.push([entry]);
      }
      return acc;
    },
    [] as PlannedCall[][],
  );

  const results: ContentBlock[] = [];
  for (const group of groups) {
    const batch = await Promise.all(
      group.map(({ block, spec }) => runOne(block, spec, service, stepRun)),
    );
    results.push(...batch);
  }
  return results;
}

async function runOne(
  block: ToolUseBlock,
  spec: ToolSpec | null,
  service: Service,
  stepRun: StepRunner | undefined,
): Promise<ContentBlock> {
  if (!spec) {
    return {
      type: "tool_result",
      toolUseId: block.id,
      content: `Error: unknown tool "${block.name}"`,
      isError: true,
    };
  }

  return tracer.startActiveSpan(
    "tool.execute",
    { attributes: { "cogmo.tool.name": block.name } },
    async (span) => {
      try {
        // Opt-in durability: wrap only when the tool is flagged AND a
        // runner is provided. The handler body itself runs between stream
        // events (never during), so wrapping in `step.run` doesn't
        // reorder `onEvent` emissions. See design/crash-recovery.md.
        const runHandler = (): Promise<string> =>
          spec.handler(block.input as Record<string, unknown>, service);
        const out =
          spec.durable === true && stepRun
            ? await stepRun(`tool-${block.name}-${block.id}`, runHandler)
            : await runHandler();
        return { type: "tool_result" as const, toolUseId: block.id, content: out };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        span.recordException(err instanceof Error ? err : new Error(message));
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        span.setAttribute("cogmo.tool.error", true);
        return {
          type: "tool_result" as const,
          toolUseId: block.id,
          content: `Error: ${message}`,
          isError: true,
        };
      } finally {
        span.end();
      }
    },
  );
}

function buildResult(
  messages: Message[],
  initialLength: number,
  ephemeralIndices: ReadonlyArray<number>,
  usage: { inputTokens: number; outputTokens: number },
  model: string,
  iterations: number,
): AgentLoopResult {
  // Extract final text from the last assistant message
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  let text = "";
  if (lastAssistant && Array.isArray(lastAssistant.content)) {
    text = lastAssistant.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  } else if (lastAssistant && typeof lastAssistant.content === "string") {
    text = lastAssistant.content;
  }

  agentIterations.record(iterations, { model });

  const ephemeral = new Set(ephemeralIndices);
  const newMessages = messages
    .slice(initialLength)
    .filter((_m, i) => !ephemeral.has(i + initialLength));

  // Defensive copy — don't leak the mutable internal array through the interface.
  // newMessages is guaranteed non-empty on the success path: the loop always
  // pushes at least one assistant message before reaching buildResult.
  return {
    text,
    messages: [...messages],
    newMessages,
    usage,
    model,
    iterations,
  };
}

/**
 * Build a degraded result for Class C / D off-ramp exits. Drops synthetic
 * continuation prompts from `newMessages` so persistence sees only the
 * successfully completed tool_use+tool_result pairs from prior
 * iterations. The orchestrator overrides `text` with the user-facing
 * apology and appends a single assistant text block on top of these
 * messages; the loop itself doesn't manufacture the apology text — that
 * lives next to the channel-aware delivery code.
 */
function buildDegradedResult(
  messages: Message[],
  initialLength: number,
  ephemeralIndices: ReadonlyArray<number>,
  usage: { inputTokens: number; outputTokens: number },
  model: string,
  iterations: number,
  reason: string,
  subtype: ClassCSubtype | null,
): AgentLoopResult {
  agentIterations.record(iterations, { model });

  const ephemeral = new Set(ephemeralIndices);
  const newMessages = messages
    .slice(initialLength)
    .filter((_m, i) => !ephemeral.has(i + initialLength));

  return {
    text: "",
    messages: [...messages],
    newMessages,
    usage,
    model,
    iterations,
    degraded: { reason, subtype },
  };
}

// --- Streaming variant ---

export interface StreamingAgentLoopParams extends AgentLoopParams {
  onEvent: (event: StreamEvent) => Promise<void>;
}

/**
 * Streaming agent loop: same logic as runAgentLoop, but streams events
 * to the caller via onEvent as they arrive from the LLM.
 *
 * Each LLM turn streams text_delta events. Tool calls are accumulated
 * from the stream, executed, and emitted as tool_result events.
 * Loops until end_turn/max_tokens or iteration limit.
 *
 * In-loop Class C handling: after each iteration's stream drains (or
 * throws), the turn outcome is classified. Empty `end_turn` triggers a
 * single continuation-prompt retry; truncated tool-arg JSON
 * (`ProviderProtocolError`) triggers a single non-streaming replay;
 * refusal degrades immediately. See `repair.ts` and
 * `design/agent-resilience.md` → Class C.
 */
export async function runStreamingAgentLoop(
  params: StreamingAgentLoopParams,
): Promise<AgentLoopResult> {
  const {
    provider,
    model,
    systemPrompt,
    tools,
    service,
    onEvent,
    stepRun,
    maxIterations = DEFAULT_MAX_ITERATIONS,
  } = params;
  const log = params.turnLogger ?? logger;
  const messages = clearOldThinking(sanitizeHistory(params.messages, log));
  const initialLength = messages.length;
  const toolDefs = tools.definitions();
  const totalUsage = { inputTokens: 0, outputTokens: 0 };
  // Tracks messages that exist only in memory for the next iteration —
  // synthetic continuation prompts injected by the repair flow. They feed
  // the model on replay but must NOT be persisted (same convention as
  // `validateHistory`-synthesized tool_results and compaction's prefix
  // summary). The index is recomputed every iteration just before
  // returning so newMessages reflects the persistable slice.
  const ephemeralIndices: number[] = [];
  const budgets: RepairBudgets = freshBudgets();
  let iterations = 0;
  let finalModel = model;

  while (iterations < maxIterations) {
    iterations++;

    const chatParams: Parameters<LlmProvider["chat"]>[0] = {
      model,
      system: systemPrompt,
      messages,
    };
    if (toolDefs.length > 0) {
      chatParams.tools = toolDefs;
    }

    let iterationContent: ContentBlock[];
    let iterationStopReason: StopReason;
    try {
      const drained = await drainStream(provider, chatParams, onEvent);
      iterationContent = drained.content;
      iterationStopReason = drained.stopReason;
      finalModel = drained.model;
      totalUsage.inputTokens += drained.usage.inputTokens;
      totalUsage.outputTokens += drained.usage.outputTokens;
    } catch (err) {
      const outcome = classifyStreamError(err, budgets);
      if (!outcome) throw err;
      if (outcome.kind === "degrade") {
        log.warn(
          { event: "agent.degrade", reason: outcome.reason, subtype: outcome.subtype },
          "agent loop degraded (stream error)",
        );
        return buildDegradedResult(
          messages,
          initialLength,
          ephemeralIndices,
          totalUsage,
          finalModel,
          iterations,
          outcome.reason,
          outcome.subtype ?? null,
        );
      }
      // repair: stream_replay — one non-streaming retry of this iteration.
      // The replay can be a separate `chat()` call since we're past the
      // streaming-required boundary; the streaming contract for the
      // caller is already satisfied for events emitted so far (none, on
      // a pre-event throw). A Class A failure during the replay
      // propagates normally — the orchestrator's outer Inngest retries
      // handle it. The stream-replay budget is consumed regardless of
      // replay outcome, per the design doc.
      budgets.stream_truncation--;
      log.warn(
        {
          event: "agent.repair",
          subtype: outcome.subtype,
          instructions: { kind: outcome.instructions.kind },
        },
        "agent loop class C repair (stream replay)",
      );
      const replay = await provider.chat(chatParams);
      iterationContent = replay.content;
      iterationStopReason = replay.stopReason;
      finalModel = replay.model;
      totalUsage.inputTokens += replay.usage.inputTokens;
      totalUsage.outputTokens += replay.usage.outputTokens;
      // Emit any tool_start events from the replay so the streaming
      // delivery sees the recovered tool_use blocks — the original
      // stream produced no usable tool_start event for them (it threw
      // mid-parse). Text deltas from the replay aren't forwarded; the
      // user has already seen a partial reply from the failed stream
      // and another emission would double up.
      for (const block of iterationContent) {
        if (block.type === "tool_use") {
          await onEvent({
            type: "tool_start",
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }
    }

    // Append assistant response to messages
    messages.push({ role: "assistant", content: iterationContent });

    // Post-stream classifier. Runs BEFORE the hasToolUse gate so an empty
    // end_turn that still has a tool_use somehow (unlikely) doesn't trip
    // the empty-content path. Refusal goes straight to degrade; empty
    // end_turn appends a synthetic user turn and re-iterates.
    const outcome = classifyPostStream(iterationContent, iterationStopReason, budgets);
    if (outcome.kind === "degrade") {
      // The just-pushed assistant message is the one that triggered the
      // degrade — pop it so newMessages doesn't carry the failing
      // iteration's output. See design/agent-resilience.md → Persistence
      // boundary on a degraded turn.
      messages.pop();
      log.warn(
        { event: "agent.degrade", reason: outcome.reason, subtype: outcome.subtype },
        "agent loop degraded (post-stream)",
      );
      return buildDegradedResult(
        messages,
        initialLength,
        ephemeralIndices,
        totalUsage,
        finalModel,
        iterations,
        outcome.reason,
        outcome.subtype ?? null,
      );
    }
    if (outcome.kind === "repair") {
      budgets[outcome.subtype]--;
      log.warn(
        {
          event: "agent.repair",
          subtype: outcome.subtype,
          instructions: { kind: outcome.instructions.kind },
        },
        "agent loop class C repair (post-stream)",
      );
      if (outcome.instructions.kind === "continuation_prompt") {
        // Drop the just-pushed empty assistant message — it has no
        // content the model can build on and would just confuse next
        // iteration's view of history. Then append the synthetic user
        // turn and mark its index as ephemeral so it doesn't make it to
        // persistence.
        messages.pop();
        messages.push({ role: "user", content: outcome.instructions.text });
        ephemeralIndices.push(messages.length - 1);
      }
      // stream_replay was handled in-line in the catch above — no extra
      // action here.
      continue;
    }

    // Drive flow on content, not `stop_reason` — see runAgentLoop above.
    const hasToolUse = iterationContent.some((b) => b.type === "tool_use");
    if (!hasToolUse) {
      return buildResult(
        messages,
        initialLength,
        ephemeralIndices,
        totalUsage,
        finalModel,
        iterations,
      );
    }

    // Execute tool calls, emit results, append to messages
    const toolResults = await executeToolCalls(iterationContent, tools, service, stepRun);

    for (const block of toolResults) {
      if (block.type === "tool_result") {
        const toolUse = iterationContent.find(
          (b): b is ToolUseBlock => b.type === "tool_use" && b.id === block.toolUseId,
        );
        const event: StreamEvent = {
          type: "tool_result",
          name: toolUse?.name ?? "unknown",
          output: block.content,
        };
        if (block.isError) event.isError = block.isError;
        await onEvent(event);
      }
    }

    messages.push({ role: "user", content: toolResults });

    log.debug(
      { iteration: iterations, toolCalls: toolResults.length },
      "streaming tool round complete",
    );
  }

  log.warn({ maxIterations }, "streaming agent loop hit iteration limit");
  log.warn(
    { event: "agent.degrade", reason: "iteration_cap", subtype: null },
    "agent loop degraded (iteration cap)",
  );
  return buildDegradedResult(
    messages,
    initialLength,
    ephemeralIndices,
    totalUsage,
    finalModel,
    iterations,
    "iteration_cap",
    null,
  );
}

interface DrainedStream {
  content: ContentBlock[];
  stopReason: StopReason;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Drain the event stream into reconstructed content blocks plus the
 * final metadata. Extracted from the loop body so the catch-on-throw
 * classifier path stays tight. Errors propagate to the caller; the
 * adapter's `response` rejection is suppressed locally so the unhandled-
 * rejection signal doesn't fire on a stream that the loop already
 * intends to classify.
 */
async function drainStream(
  provider: LlmProvider,
  chatParams: Parameters<LlmProvider["chat"]>[0],
  onEvent: (event: StreamEvent) => Promise<void>,
): Promise<DrainedStream> {
  const { events, response } = provider.chatStream(chatParams);
  // Adapters reject `response` independently when the events stream
  // throws (anthropic.ts, openai-compat.ts, and fallback.ts all do this).
  // The success path below awaits `response` after draining `events`, but
  // a `for await` throw skips that await — leaving the parallel rejection
  // dangling. Node's default `unhandledRejection=throw` then terminates
  // the process. The noop suppresses the unhandled-rejection signal; an
  // `await response` later still surfaces the same error normally.
  response.catch(() => {});

  const contentBlocks: ContentBlock[] = [];
  let currentText = "";

  for await (const event of events) {
    // Don't forward thinking events to the delivery layer — they're internal
    if (event.type !== "thinking_delta") {
      await onEvent(event);
    }

    if (event.type === "text_delta") {
      currentText += event.text;
    } else if (event.type === "thinking_delta") {
      // Flush any accumulated text before inserting thinking block
      if (currentText) {
        contentBlocks.push({ type: "text", text: currentText });
        currentText = "";
      }
      contentBlocks.push({
        type: "thinking",
        thinking: event.thinking,
        signature: event.signature,
      });
    } else if (event.type === "tool_start") {
      // Flush accumulated text as a block
      if (currentText) {
        contentBlocks.push({ type: "text", text: currentText });
        currentText = "";
      }
      contentBlocks.push({
        type: "tool_use",
        id: event.id,
        name: event.name,
        input: event.input,
      });
    }
  }

  // Flush remaining text
  if (currentText) {
    contentBlocks.push({ type: "text", text: currentText });
  }

  const meta = await response;
  return {
    content: contentBlocks,
    stopReason: meta.stopReason,
    model: meta.model,
    usage: meta.usage,
  };
}
