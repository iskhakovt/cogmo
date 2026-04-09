import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../logger.js";
import type { LlmProvider } from "./provider.js";
import type {
  ChatParams,
  ChatStreamResult,
  ContentBlock,
  CountTokensParams,
  LlmResponse,
  Message,
  StopReason,
  StreamEvent,
  ToolDefinition,
  Usage,
} from "./types.js";

const DEFAULT_MAX_TOKENS = 8192;

/**
 * Anthropic SDK adapter.
 *
 * Translates between our canonical types and the Anthropic Messages API.
 * The mapping is nearly 1:1 — Anthropic's format inspired our canonical types.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  #client: Anthropic;

  constructor(apiKey: string, baseURL?: string) {
    this.#client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  chatStream(params: ChatParams): ChatStreamResult {
    if (params.responseFormat && params.tools?.length) {
      throw new Error("responseFormat and tools are mutually exclusive");
    }

    const anthropicParams = buildCreateParams(params);
    let resolveResponse: (v: { stopReason: StopReason; model: string; usage: Usage }) => void;
    const response = new Promise<{ stopReason: StopReason; model: string; usage: Usage }>(
      (resolve) => {
        resolveResponse = resolve;
      },
    );

    const client = this.#client;

    async function* generateEvents(): AsyncIterable<StreamEvent> {
      const stream = await client.messages.create({ ...anthropicParams, stream: true });

      // Track tool_use blocks by index for input accumulation
      const toolBlocks = new Map<number, { id: string; name: string; jsonChunks: string[] }>();
      // Track thinking blocks by index for content accumulation
      const thinkingBlocks = new Map<number, { signature: string; chunks: string[] }>();
      let model = "";
      let stopReason: StopReason = "end_turn";
      const usage: Usage = { inputTokens: 0, outputTokens: 0 };

      for await (const event of stream) {
        switch (event.type) {
          case "message_start":
            model = event.message.model;
            usage.inputTokens = event.message.usage.input_tokens;
            usage.outputTokens = event.message.usage.output_tokens;
            if (event.message.usage.cache_read_input_tokens != null)
              usage.cacheReadTokens = event.message.usage.cache_read_input_tokens;
            if (event.message.usage.cache_creation_input_tokens != null)
              usage.cacheCreationTokens = event.message.usage.cache_creation_input_tokens;
            break;

          case "content_block_start":
            if (event.content_block.type === "tool_use") {
              toolBlocks.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                jsonChunks: [],
              });
            } else if (event.content_block.type === "thinking") {
              thinkingBlocks.set(event.index, {
                signature: event.content_block.signature,
                chunks: [],
              });
            }
            break;

          case "content_block_delta":
            if (event.delta.type === "text_delta") {
              yield { type: "text_delta", text: event.delta.text };
            } else if (event.delta.type === "input_json_delta") {
              const block = toolBlocks.get(event.index);
              if (block) {
                block.jsonChunks.push(event.delta.partial_json);
              }
            } else if (event.delta.type === "thinking_delta") {
              const block = thinkingBlocks.get(event.index);
              if (block) {
                block.chunks.push(event.delta.thinking);
              }
            }
            break;

          case "content_block_stop": {
            const toolBlock = toolBlocks.get(event.index);
            if (toolBlock) {
              const input = JSON.parse(toolBlock.jsonChunks.join(""));
              yield { type: "tool_start", id: toolBlock.id, name: toolBlock.name, input };
              toolBlocks.delete(event.index);
            }
            const thinkingBlock = thinkingBlocks.get(event.index);
            if (thinkingBlock) {
              // Emit as a thinking_delta with the full accumulated text + signature.
              // The agent loop captures this into a ThinkingBlock.
              yield {
                type: "thinking_delta",
                thinking: thinkingBlock.chunks.join(""),
                signature: thinkingBlock.signature,
              };
              thinkingBlocks.delete(event.index);
            }
            break;
          }

          case "message_delta":
            stopReason = fromAnthropicStopReason(event.delta.stop_reason);
            usage.outputTokens = event.usage.output_tokens;
            break;
        }
      }

      resolveResponse({ stopReason, model, usage });
    }

    return { events: generateEvents(), response };
  }

  async countTokens(params: CountTokensParams): Promise<number> {
    const built = buildCreateParams({ ...params, maxTokens: 1 });
    const countParams: Anthropic.MessageCountTokensParams = {
      model: built.model,
      messages: built.messages,
    };
    if (built.system) countParams.system = built.system;
    if (built.tools) countParams.tools = built.tools;
    const result = await this.#client.messages.countTokens(countParams);
    return result.input_tokens;
  }

  async chat(params: ChatParams): Promise<LlmResponse> {
    if (params.responseFormat && params.tools?.length) {
      throw new Error("responseFormat and tools are mutually exclusive");
    }

    const response = await this.#client.messages.create(buildCreateParams(params));

    const usage: Usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(response.usage.cache_read_input_tokens != null && {
        cacheReadTokens: response.usage.cache_read_input_tokens,
      }),
      ...(response.usage.cache_creation_input_tokens != null && {
        cacheCreationTokens: response.usage.cache_creation_input_tokens,
      }),
    };

    // When responseFormat is set, the model is forced to call a synthetic tool.
    // Normalize: extract tool input as JSON text, set stopReason to end_turn.
    if (params.responseFormat) {
      const toolUse = response.content.find((b) => b.type === "tool_use");
      if (toolUse && toolUse.type === "tool_use") {
        return {
          content: [{ type: "text", text: JSON.stringify(toolUse.input) }],
          stopReason: "end_turn",
          model: response.model,
          usage,
        };
      }
      logger.warn("responseFormat set but no tool_use block in response");
    }

    return {
      content: response.content.flatMap(fromAnthropicBlock),
      stopReason: fromAnthropicStopReason(response.stop_reason),
      model: response.model,
      usage,
    };
  }
}

// --- Params builder ---

function buildCreateParams(params: ChatParams): Anthropic.MessageCreateParamsNonStreaming {
  // System prompt as content block array with cache_control on the last block.
  // Tools + system are static per conversation — caching saves 90% on reads.
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: params.system, cache_control: { type: "ephemeral" } },
  ];

  // When responseFormat is set, use the tool_use trick: define a synthetic tool
  // with the schema and force the model to call it via tool_choice.
  if (params.responseFormat) {
    const syntheticTool = toAnthropicTool({
      name: params.responseFormat.name,
      description: "Respond with structured data matching the schema.",
      parameters: params.responseFormat.schema,
    });
    syntheticTool.cache_control = { type: "ephemeral" };

    const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;
    return {
      model: params.model,
      max_tokens: maxTokens,
      system: systemBlocks,
      messages: params.messages.map(toAnthropicMessage),
      tools: [syntheticTool],
      tool_choice: { type: "tool", name: params.responseFormat.name },
    };
  }

  // Add cache_control to the last tool (caches all tools as a prefix)
  const tools = params.tools?.length ? params.tools.map(toAnthropicTool) : undefined;
  if (tools && tools.length > 0) {
    const last = tools[tools.length - 1];
    if (last) tools[tools.length - 1] = { ...last, cache_control: { type: "ephemeral" } };
  }

  const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;

  const result: Anthropic.MessageCreateParamsNonStreaming = {
    model: params.model,
    max_tokens: params.thinking ? params.thinking.budgetTokens + maxTokens : maxTokens,
    system: systemBlocks,
    messages: params.messages.map(toAnthropicMessage),
    ...(tools && { tools }),
  };

  if (params.thinking) {
    result.thinking = { type: "enabled", budget_tokens: params.thinking.budgetTokens };
  }

  return result;
}

// --- To Anthropic format ---

function toAnthropicMessage(msg: Message): Anthropic.MessageParam {
  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content };
  }

  return {
    role: msg.role,
    content: msg.content.map(toAnthropicBlock),
  };
}

function toAnthropicBlock(
  block: ContentBlock,
): Anthropic.ContentBlockParam | Anthropic.ToolResultBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return { type: "thinking", thinking: block.thinking, signature: block.signature };
    case "image":
      return {
        type: "image",
        source:
          block.source === "base64"
            ? {
                type: "base64",
                data: block.data,
                media_type: block.mediaType as
                  | "image/jpeg"
                  | "image/png"
                  | "image/gif"
                  | "image/webp",
              }
            : { type: "url", url: block.data },
      };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result": {
      const result: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
      };
      if (block.isError !== undefined) {
        result.is_error = block.isError;
      }
      return result;
    }
  }
}

function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
  const inputSchema: Anthropic.Tool["input_schema"] = {
    type: "object" as const,
  };
  if (tool.parameters.properties !== undefined) {
    inputSchema.properties = tool.parameters.properties;
  }
  if (tool.parameters.required !== undefined) {
    inputSchema.required = tool.parameters.required;
  }
  return {
    name: tool.name,
    description: tool.description,
    input_schema: inputSchema,
  };
}

// --- From Anthropic format ---

function fromAnthropicBlock(block: Anthropic.ContentBlock): ContentBlock[] {
  switch (block.type) {
    case "text":
      return [{ type: "text", text: block.text }];
    case "tool_use":
      return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
    case "thinking":
      return [{ type: "thinking", thinking: block.thinking, signature: block.signature }];
    default:
      // Skip block types we don't handle (server_tool_use, etc.)
      return [];
  }
}

function fromAnthropicStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "end_turn";
  }
}
