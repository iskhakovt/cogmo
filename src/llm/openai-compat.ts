import { getEncoding, type Tiktoken } from "js-tiktoken";
import OpenAI from "openai";
import type { LlmProvider } from "./provider.js";
import type {
  ChatParams,
  ChatStreamResult,
  ContentBlock,
  CountTokensParams,
  ImageBlock,
  LlmResponse,
  Message,
  StopReason,
  StreamEvent,
  TextBlock,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from "./types.js";

const DEFAULT_MAX_TOKENS = 8192;

// Lazy-init singleton — cl100k_base covers GPT-4, GPT-4o, GPT-3.5-turbo
let encoder: Tiktoken | null = null;
function getEncoder(): Tiktoken {
  if (!encoder) encoder = getEncoding("cl100k_base");
  return encoder;
}

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseURL: string;
  headers?: Record<string, string>;
  /** Add Anthropic-style cache_control hints for OpenRouter routing to Claude models. */
  promptCaching?: boolean;
}

/**
 * OpenAI-compatible adapter — works with OpenAI, xAI (Grok), OpenRouter,
 * DeepSeek, Groq, Together, or any Chat Completions-compatible endpoint.
 *
 * Uses the official OpenAI SDK with configurable baseURL and headers.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  #client: OpenAI;
  #promptCaching: boolean;

  constructor(name: string, config: OpenAICompatibleConfig) {
    this.name = name;
    this.#promptCaching = config.promptCaching ?? false;
    this.#client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultHeaders: config.headers,
    });
  }

  async countTokens(params: CountTokensParams): Promise<number> {
    const enc = getEncoder();
    const msgs = buildMessages(params.system, params.messages, this.#promptCaching);
    let tokens = 0;

    for (const msg of msgs) {
      tokens += 4; // message framing overhead (role, separators)

      if (typeof msg.content === "string") {
        tokens += enc.encode(msg.content).length;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content as Array<{ type: string; text?: string }>) {
          if (part.type === "text" && part.text) {
            tokens += enc.encode(part.text).length;
          }
          // Images: ~85 tokens base for low-detail, more for high-detail.
          // Conservative estimate since we don't know the detail setting.
          if (part.type === "image_url") tokens += 85;
        }
      }

      // Tool calls on assistant messages
      const toolCalls = (msg as unknown as Record<string, unknown>).tool_calls as
        | Array<{ function: { name: string; arguments: string } }>
        | undefined;
      if (toolCalls) {
        for (const tc of toolCalls) {
          tokens += enc.encode(tc.function.name).length;
          tokens += enc.encode(tc.function.arguments).length;
        }
      }

      // Tool role messages (tool results)
      if ((msg as { role: string }).role === "tool") {
        const toolContent = (msg as { content?: string }).content;
        if (toolContent) tokens += enc.encode(toolContent).length;
      }
    }

    // Tool definitions
    if (params.tools?.length) {
      for (const tool of params.tools) {
        tokens += enc.encode(JSON.stringify(tool)).length;
      }
    }

    tokens += 3; // reply priming
    return tokens;
  }

  async chat(params: ChatParams): Promise<LlmResponse> {
    if (params.responseFormat && params.tools?.length) {
      throw new Error("responseFormat and tools are mutually exclusive");
    }

    const createParams: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: buildMessages(params.system, params.messages, this.#promptCaching),
    };

    if (params.tools?.length) {
      createParams.tools = params.tools.map(toOpenAITool);
    }

    if (params.responseFormat) {
      createParams.response_format = {
        type: "json_schema",
        json_schema: {
          name: params.responseFormat.name,
          schema: params.responseFormat.schema,
          strict: true,
        },
      };
    }

    const response = await this.#client.chat.completions.create(createParams);

    const choice = response.choices[0];
    if (!choice) throw new Error("No choices in response");

    return {
      content: fromOpenAIMessage(choice.message),
      stopReason: fromOpenAIFinishReason(choice.finish_reason),
      model: response.model,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  chatStream(params: ChatParams): ChatStreamResult {
    if (params.responseFormat && params.tools?.length) {
      throw new Error("responseFormat and tools are mutually exclusive");
    }

    let resolveResponse: (v: { stopReason: StopReason; model: string; usage: Usage }) => void;
    const response = new Promise<{ stopReason: StopReason; model: string; usage: Usage }>(
      (resolve) => {
        resolveResponse = resolve;
      },
    );

    const client = this.#client;
    const caching = this.#promptCaching;

    async function* generateEvents(): AsyncIterable<StreamEvent> {
      const stream = await client.chat.completions.create({
        model: params.model,
        max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: buildMessages(params.system, params.messages, caching),
        ...(params.tools?.length && { tools: params.tools.map(toOpenAITool) }),
        stream: true,
        stream_options: { include_usage: true },
      });

      let model = params.model;
      const usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let finishReason: StopReason = "end_turn";

      // Accumulate tool call arguments per index (streamed as deltas)
      const toolCalls = new Map<number, { id: string; name: string; argumentChunks: string[] }>();

      for await (const chunk of stream) {
        if (chunk.model) model = chunk.model;

        // Usage comes in the final chunk (stream_options: include_usage)
        if (chunk.usage) {
          usage.inputTokens = chunk.usage.prompt_tokens;
          usage.outputTokens = chunk.usage.completion_tokens;
        }

        const delta = chunk.choices[0]?.delta;
        const reason = chunk.choices[0]?.finish_reason;

        if (reason) {
          finishReason = fromOpenAIFinishReason(reason);
        }

        if (!delta) continue;

        // Text content
        if (delta.content) {
          yield { type: "text_delta", text: delta.content };
        }

        // Tool calls — streamed as deltas with index
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            let call = toolCalls.get(tc.index);
            if (!call) {
              call = {
                id: tc.id ?? "",
                name: tc.function?.name ?? "",
                argumentChunks: [],
              };
              toolCalls.set(tc.index, call);
            }
            if (tc.id) call.id = tc.id;
            if (tc.function?.name) call.name = tc.function.name;
            if (tc.function?.arguments) {
              call.argumentChunks.push(tc.function.arguments);
            }
          }
        }
      }

      // Yield accumulated tool calls as complete tool_start events
      for (const [, call] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
        const input = JSON.parse(call.argumentChunks.join(""));
        yield { type: "tool_start", id: call.id, name: call.name, input };
      }

      resolveResponse({ stopReason: finishReason, model, usage });
    }

    return { events: generateEvents(), response };
  }
}

// --- Message building ---

function buildMessages(
  system: string,
  messages: Message[],
  promptCaching: boolean,
): OpenAI.ChatCompletionMessageParam[] {
  // When promptCaching is enabled (OpenRouter → Anthropic), add cache_control
  // on the system message content block. OpenRouter passes it through to Claude.
  const systemMsg: OpenAI.ChatCompletionMessageParam = promptCaching
    ? {
        role: "system",
        // cache_control is an OpenRouter extension, not in OpenAI's types
        content: [{ type: "text", text: system, cache_control: { type: "ephemeral" } } as any],
      }
    : { role: "system", content: system };
  const result: OpenAI.ChatCompletionMessageParam[] = [systemMsg];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role as "user" | "assistant", content: msg.content });
      continue;
    }

    // Content blocks — handle tool_use and tool_result specially
    if (msg.role === "assistant") {
      // Skip ThinkingBlock — not supported by OpenAI-compatible endpoints
      const textBlocks = msg.content.filter((b): b is TextBlock => b.type === "text");
      const toolUseBlocks = msg.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

      const textContent = textBlocks.map((b) => b.text).join("");
      const toolCalls = toolUseBlocks.map((b) => ({
        id: b.id,
        type: "function" as const,
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input),
        },
      }));

      result.push({
        role: "assistant",
        content: textContent || null,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      });
    } else {
      // User message — may contain tool_result, text, and image blocks
      const toolResults = msg.content.filter((b): b is ToolResultBlock => b.type === "tool_result");
      const textBlocks = msg.content.filter((b): b is TextBlock => b.type === "text");
      const imageBlocks = msg.content.filter((b): b is ImageBlock => b.type === "image");

      // Tool results become separate "tool" role messages
      for (const tr of toolResults) {
        result.push({
          role: "tool",
          tool_call_id: tr.toolUseId,
          content: tr.content,
        });
      }

      // Text + images → multipart content array
      if (textBlocks.length > 0 || imageBlocks.length > 0) {
        const parts: OpenAI.ChatCompletionContentPart[] = [];
        for (const tb of textBlocks) {
          parts.push({ type: "text", text: tb.text });
        }
        for (const ib of imageBlocks) {
          const url = ib.source === "url" ? ib.data : `data:${ib.mediaType};base64,${ib.data}`;
          parts.push({ type: "image_url", image_url: { url } });
        }
        result.push({
          role: "user",
          content: imageBlocks.length > 0 ? parts : textBlocks.map((b) => b.text).join(""),
        });
      }
    }
  }

  return result;
}

// --- Tool definition mapping ---

function toOpenAITool(tool: ToolDefinition): OpenAI.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  };
}

// --- Response mapping ---

function fromOpenAIMessage(message: OpenAI.ChatCompletionMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (message.content) {
    blocks.push({ type: "text", text: message.content });
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      if (tc.type !== "function") continue;
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    }
  }

  return blocks;
}

function fromOpenAIFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}
