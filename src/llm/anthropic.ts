import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../logger.js";
import { withFailureLogging } from "./logging-fetch.js";
import { failChatSpan, recordChatUsage, startChatSpan } from "./otel.js";
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
    this.#client = new Anthropic({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      fetch: withFailureLogging(globalThis.fetch, logger, this.name),
    });
  }

  chatStream(params: ChatParams): ChatStreamResult {
    if (params.responseFormat && params.tools?.length) {
      throw new Error("responseFormat and tools are mutually exclusive");
    }

    const anthropicParams = buildCreateParams(params);
    let resolveResponse: (v: { stopReason: StopReason; model: string; usage: Usage }) => void;
    let rejectResponse: (err: unknown) => void;
    const response = new Promise<{ stopReason: StopReason; model: string; usage: Usage }>(
      (resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      },
    );

    const client = this.#client;
    const providerName = this.name;
    const span = startChatSpan(providerName, params.model);

    async function* generateEvents(): AsyncIterable<StreamEvent> {
      let completed = false;
      try {
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
                // Malformed tool-use JSON: attribute to the span before the
                // generator unwinds, matching the catch branch below.
                let input: unknown;
                try {
                  input = JSON.parse(toolBlock.jsonChunks.join(""));
                } catch (parseErr) {
                  completed = true;
                  failChatSpan(span, parseErr);
                  rejectResponse(parseErr);
                  throw parseErr;
                }
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

        recordChatUsage(span, providerName, model, usage, stopReason);
        completed = true;
        resolveResponse({ stopReason, model, usage });
      } catch (err) {
        completed = true;
        failChatSpan(span, err);
        rejectResponse(err);
        throw err;
      } finally {
        if (!completed) {
          // Generator was returned early (consumer broke out of for-await
          // without an exception). Reject the response promise so awaiters
          // don't hang and mark the span as incomplete.
          const abortErr = new Error("chatStream consumer abandoned the stream");
          failChatSpan(span, abortErr);
          rejectResponse(abortErr);
        }
        span.end();
      }
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

    const span = startChatSpan(this.name, params.model);
    try {
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

      const stopReason = fromAnthropicStopReason(response.stop_reason);
      recordChatUsage(span, this.name, response.model, usage, stopReason);

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
        stopReason,
        model: response.model,
        usage,
      };
    } catch (err) {
      failChatSpan(span, err);
      throw err;
    } finally {
      span.end();
    }
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
    case "document": {
      // Anthropic's document block accepts: PDF (base64/url/files), text/plain
      // (text source / files / url), and url-source for any URL.
      // We expand the supported text family by transcoding text-like inputs
      // (text/*, application/json|xml|yaml) into the `text` source variant —
      // Anthropic's API only labels them `text/plain` but Claude reads them
      // as code/markdown/CSV/etc. just fine; the original filename rides on
      // `title` so the model still knows what it was.
      const mt = block.mediaType;
      if (block.source === "url") {
        return {
          type: "document",
          source: { type: "url", url: block.data },
          ...(block.name && { title: block.name }),
        };
      }
      if (isTextLikeDocumentMediaType(mt)) {
        // base64 → utf-8 is lossy when an upload mislabels its mediaType
        // (binary tagged as text/* gets U+FFFD replacement chars). Soft-fail
        // path — model receives mangled text rather than crashing.
        return {
          type: "document",
          source: {
            type: "text",
            media_type: "text/plain",
            data: Buffer.from(block.data, "base64").toString("utf-8"),
          },
          ...(block.name && { title: block.name }),
        };
      }
      // Pre-flight narrow: Anthropic's base64 document source only accepts
      // application/pdf. Throw with a clear message rather than burning a
      // 400 round-trip on application/zip, application/octet-stream, etc.
      // Control flow narrows `mt` to the literal "application/pdf" below.
      if (mt !== "application/pdf") {
        throw new Error(
          `Anthropic document block: unsupported mediaType "${mt}". Expected application/pdf or a text-like type (text/*, application/json|xml|yaml).`,
        );
      }
      return {
        type: "document",
        source: { type: "base64", media_type: mt, data: block.data },
        ...(block.name && { title: block.name }),
      };
    }
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

/**
 * Document mediaTypes we route through Anthropic's `text` source variant.
 *
 * Anthropic only labels the wire type `text/plain` (per API contract), but
 * Claude reads structured text (markdown, csv, json, xml, yaml) just fine —
 * the original filename is surfaced via `title` so the model still knows
 * what kind of text it was.
 */
function isTextLikeDocumentMediaType(mt: string): boolean {
  if (mt.startsWith("text/")) return true;
  return (
    mt === "application/json" ||
    mt === "application/xml" ||
    mt === "application/yaml" ||
    mt === "application/x-yaml"
  );
}

function fromAnthropicStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      // Anthropic's explicit refusal signal on recent models. Surfaces the
      // Class C "model refusal" subtype (design/agent-resilience.md) to the
      // in-loop classifier.
      return "refusal";
    default:
      return "end_turn";
  }
}
