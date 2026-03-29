import type { LlmProvider } from "../llm/provider.js";
import type { ContentBlock, LlmResponse, Message } from "../llm/types.js";
import { logger } from "../logger.js";
import type { Service } from "./service.js";
import type { ToolRegistry } from "./tools.js";

export interface AgentLoopParams {
  provider: LlmProvider;
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolRegistry;
  service: Service;
  maxIterations?: number;
}

export interface AgentLoopResult {
  /** Final assistant text response */
  text: string;
  /** Full message history including tool calls/results */
  messages: Message[];
  /** Aggregated usage across all LLM calls */
  usage: { inputTokens: number; outputTokens: number };
  /** Which model was used */
  model: string;
  /** Number of LLM calls made */
  iterations: number;
}

const DEFAULT_MAX_ITERATIONS = 20;

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
    maxIterations = DEFAULT_MAX_ITERATIONS,
  } = params;
  const messages = [...params.messages];
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

    // If not a tool_use stop, we're done
    if (response.stopReason !== "tool_use") {
      return buildResult(messages, response, totalUsage, finalModel, iterations);
    }

    // Execute tool calls and append results
    const toolResults = await executeToolCalls(response.content, tools, service);
    messages.push({ role: "user", content: toolResults });

    logger.debug({ iteration: iterations, toolCalls: toolResults.length }, "tool round complete");
  }

  logger.warn({ maxIterations }, "agent loop hit iteration limit");
  return buildResult(messages, null, totalUsage, finalModel, iterations);
}

async function executeToolCalls(
  content: ContentBlock[],
  tools: ToolRegistry,
  service: Service,
): Promise<ContentBlock[]> {
  const toolUseBlocks = content.filter((b) => b.type === "tool_use");
  const results: ContentBlock[] = [];

  for (const block of toolUseBlocks) {
    if (block.type !== "tool_use") continue;

    const spec = tools.get(block.name);
    if (!spec) {
      results.push({
        type: "tool_result",
        toolUseId: block.id,
        content: `Error: unknown tool "${block.name}"`,
        isError: true,
      });
      continue;
    }

    try {
      const result = await spec.handler(block.input as Record<string, unknown>, service);
      results.push({ type: "tool_result", toolUseId: block.id, content: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        type: "tool_result",
        toolUseId: block.id,
        content: `Error: ${message}`,
        isError: true,
      });
    }
  }

  return results;
}

function buildResult(
  messages: Message[],
  _lastResponse: LlmResponse | null,
  usage: { inputTokens: number; outputTokens: number },
  model: string,
  iterations: number,
): AgentLoopResult {
  // Extract final text from the last assistant message
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  let text = "";
  if (lastAssistant && Array.isArray(lastAssistant.content)) {
    text = lastAssistant.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
  } else if (lastAssistant && typeof lastAssistant.content === "string") {
    text = lastAssistant.content;
  }

  // Defensive copy — don't leak the mutable internal array through the interface
  return { text, messages: [...messages], usage, model, iterations };
}
