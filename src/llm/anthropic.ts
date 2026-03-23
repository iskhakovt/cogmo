import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider } from "./provider.js";
import type {
  ChatParams,
  ContentBlock,
  LlmResponse,
  Message,
  StopReason,
  ToolDefinition,
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
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(params: ChatParams): Promise<LlmResponse> {
    const response = await this.client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: params.system,
      messages: params.messages.map(toAnthropicMessage),
      ...(params.tools?.length && { tools: params.tools.map(toAnthropicTool) }),
    });

    return {
      content: response.content.flatMap(fromAnthropicBlock),
      stopReason: fromAnthropicStopReason(response.stop_reason),
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
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
    default:
      // Skip block types we don't handle (thinking, server_tool_use, etc.)
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
