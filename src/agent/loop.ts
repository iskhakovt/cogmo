import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { LlmProvider } from "../llm/provider.js";
import type { ContentBlock, Message, StreamEvent, TextBlock, ToolUseBlock } from "../llm/types.js";
import { logger } from "../logger.js";
import { agentIterations } from "../metrics.js";
import { validateHistory } from "./history-invariants.js";
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
function sanitizeHistory(messages: ReadonlyArray<Message>): Message[] {
  const { messages: repaired, repairs } = validateHistory(messages);
  if (repairs.length > 0) {
    logger.warn({ repairCount: repairs.length, repairs }, "agent loop history invariants repaired");
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
  const messages = clearOldThinking(sanitizeHistory(params.messages));
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
      return buildResult(messages, initialLength, totalUsage, finalModel, iterations);
    }

    // Execute tool calls and append results
    const toolResults = await executeToolCalls(response.content, tools, service, stepRun);
    messages.push({ role: "user", content: toolResults });

    logger.debug({ iteration: iterations, toolCalls: toolResults.length }, "tool round complete");
  }

  logger.warn({ maxIterations }, "agent loop hit iteration limit");
  return buildResult(messages, initialLength, totalUsage, finalModel, iterations);
}

async function executeToolCalls(
  content: ContentBlock[],
  tools: ToolRegistry,
  service: Service,
  stepRun: StepRunner | undefined,
): Promise<ContentBlock[]> {
  const toolUseBlocks = content.filter((b): b is ToolUseBlock => b.type === "tool_use");
  if (toolUseBlocks.length === 0) return [];

  // Each entry pairs the tool_use with the resolved spec (or null for
  // unknown tools, which short-circuit to an error result). We resolve up
  // front so the parallel-safety decision sees every tool in the batch
  // without re-scanning the registry mid-flight.
  const planned = toolUseBlocks.map((block) => ({
    block,
    spec: tools.get(block.name) ?? null,
  }));

  // Fan out only when every block in the batch is either an unknown-tool
  // short-circuit (cheap, no side effects) or a parallelSafe spec. One
  // unsafe entry forces the whole batch back to sequential — the LLM emits
  // tool_use blocks in some order but doesn't expect any particular order,
  // so partial parallelism would create real concurrency between unsafe
  // writes and sibling reads against the same shared state.
  const canFanOut = planned.every((p) => p.spec === null || p.spec.parallelSafe === true);

  if (canFanOut && planned.length > 1) {
    return Promise.all(planned.map(({ block, spec }) => runOne(block, spec, service, stepRun)));
  }

  const results: ContentBlock[] = [];
  for (const { block, spec } of planned) {
    results.push(await runOne(block, spec, service, stepRun));
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

  // Defensive copy — don't leak the mutable internal array through the interface.
  // newMessages is guaranteed non-empty: the loop always pushes at least one
  // assistant message before reaching buildResult (either via end_turn/max_tokens
  // or the iteration-limit fallback).
  return {
    text,
    messages: [...messages],
    newMessages: messages.slice(initialLength),
    usage,
    model,
    iterations,
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
  const messages = clearOldThinking(sanitizeHistory(params.messages));
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

    const { events, response } = provider.chatStream(chatParams);
    // Adapters reject `response` independently when the events stream
    // throws (anthropic.ts, openai-compat.ts, and fallback.ts all do this).
    // The success path below awaits `response` after draining `events`, but
    // a `for await` throw skips that await — leaving the parallel rejection
    // dangling. Node's default `unhandledRejection=throw` then terminates
    // the process. The noop suppresses the unhandled-rejection signal; an
    // `await response` later still surfaces the same error normally.
    response.catch(() => {});

    // Stream events + reconstruct content blocks for the messages array
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

    // Await final metadata
    const meta = await response;
    finalModel = meta.model;
    totalUsage.inputTokens += meta.usage.inputTokens;
    totalUsage.outputTokens += meta.usage.outputTokens;

    // Append assistant response to messages
    messages.push({ role: "assistant", content: contentBlocks });

    // Drive flow on content, not `stop_reason` — see runAgentLoop above.
    const hasToolUse = contentBlocks.some((b) => b.type === "tool_use");
    if (!hasToolUse) {
      return buildResult(messages, initialLength, totalUsage, finalModel, iterations);
    }

    // Execute tool calls, emit results, append to messages
    const toolResults = await executeToolCalls(contentBlocks, tools, service, stepRun);

    for (const block of toolResults) {
      if (block.type === "tool_result") {
        const toolUse = contentBlocks.find(
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

    logger.debug(
      { iteration: iterations, toolCalls: toolResults.length },
      "streaming tool round complete",
    );
  }

  logger.warn({ maxIterations }, "streaming agent loop hit iteration limit");
  return buildResult(messages, initialLength, totalUsage, finalModel, iterations);
}
