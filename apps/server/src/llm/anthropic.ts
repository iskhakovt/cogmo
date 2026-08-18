import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../logger.js";
import { parseToolArgs } from "./errors.js";
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
              } else if (event.delta.type === "signature_delta") {
                // The signature arrives here, just before the block's
                // `content_block_stop` — `content_block_start` carries an
                // empty one. Without it the block we rebuild is not the
                // block the model sent, and replaying it into history is
                // rejected as a modified thinking block.
                const block = thinkingBlocks.get(event.index);
                if (block) {
                  block.signature = event.delta.signature;
                }
              }
              break;

            case "content_block_stop": {
              const toolBlock = toolBlocks.get(event.index);
              if (toolBlock) {
                // parseToolArgs wraps SyntaxError as ProviderProtocolError so
                // the fallback chain doesn't misclassify it as transient.
                let input: unknown;
                try {
                  input = parseToolArgs(
                    toolBlock.jsonChunks.join(""),
                    toolBlock.name,
                    "Anthropic streamed tool_use input",
                  );
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

const warnedSamplingModels = new Set<string>();

/**
 * The Messages API rejects sampling parameters (`temperature`, `top_p`,
 * `top_k`) with a 400 on Opus 4.7 and later and on the whole 5 series —
 * every model Anthropic currently fronts. Older ones (Sonnet 4.6, Opus
 * 4.6) still accept them, and the drop is unconditional anyway: keying it
 * on the model means a table of which ids accept what, which is the kind
 * of thing that goes stale silently and 400s the request when it does.
 * The one caller wants low variance on a three-sentence apology, so what
 * it costs on an older model is negligible.
 *
 * `ChatParams.temperature` stays canonical because the OpenAI-compatible
 * adapter honours it. Warning once per model means a caller asking for
 * determinism can see it wasn't granted rather than assuming it landed.
 */
function dropSamplingParams(params: ChatParams): void {
  if (params.temperature === undefined) return;
  if (warnedSamplingModels.has(params.model)) return;
  warnedSamplingModels.add(params.model);
  logger.warn(
    { model: params.model, temperature: params.temperature },
    `dropping temperature for "${params.model}" — the Anthropic adapter sends no sampling ` +
      `parameters, because current models reject them. Control response variance with the ` +
      `prompt, or route this call to an OpenAI-compatible provider.`,
  );
}

function buildCreateParams(params: ChatParams): Anthropic.MessageCreateParamsNonStreaming {
  dropSamplingParams(params);

  // System prompt as content block array with cache_control on the last block.
  // Tools + system are static per conversation — caching saves 90% on reads.
  // Omit the block when there's no prompt: Anthropic rejects an empty-text
  // content block, and a null-persona sub-agent passes system: "".
  const systemBlocks: Anthropic.TextBlockParam[] =
    params.system.trim().length > 0
      ? [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }]
      : [];

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
      ...(systemBlocks.length > 0 && { system: systemBlocks }),
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

  // No `thinking` parameter: each model applies its own default, which is
  // adaptive thinking on Sonnet 5 and the rest of the 5 series. Explicit
  // depth control belongs in `output_config.effort`, which nothing needs
  // yet. Thinking blocks that come back are translated by
  // `toAnthropicMessage` / `toCanonicalBlock` either way.
  return {
    model: params.model,
    max_tokens: maxTokens,
    ...(systemBlocks.length > 0 && { system: systemBlocks }),
    messages: params.messages.map(toAnthropicMessage),
    ...(tools && { tools }),
  };
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

/**
 * Map Anthropic's `stop_reason` onto our canonical {@link StopReason}.
 *
 * The parameter is the SDK's own `StopReason` union rather than `string`, so
 * the switch below is exhaustive and the `default` arm's `never` assignment
 * is a compile error the moment the SDK grows a value we haven't decided how
 * to map. A widened parameter type would let a new upstream stop reason fold
 * silently into `end_turn`, which is the worst possible default: `end_turn`
 * with no content blocks is the signal `classifyPostStream` reads as "model
 * returned an empty turn", so the loop would answer an unmapped terminal
 * condition with a continuation prompt.
 */
function fromAnthropicStopReason(reason: Anthropic.StopReason | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case null:
      // Streamed `message_delta` carries `stop_reason: null` until the final
      // delta; a nullish terminal value means the turn ended without the API
      // naming a reason.
      return "end_turn";
    case "pause_turn":
      // A long-running server-tool turn the API paused and expects to be
      // handed back for continuation. We don't drive server tools, so this
      // arrives with content and terminates the turn like a normal stop.
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "model_context_window_exceeded":
      // Input plus output overran the model's context window. Its own
      // canonical member because the recovery differs from every other stop:
      // there is no token room left, so any repair that appends to the
      // request (continuation prompt, replay) re-fails identically.
      // `classifyPostStream` degrades the turn on this value — see
      // `StopReason` in llm/types.ts.
      return "context_overflow";
    case "refusal":
      // Anthropic's explicit refusal signal on recent models. Surfaces the
      // Class C "model refusal" subtype (design/agent-resilience.md) to the
      // in-loop classifier.
      return "refusal";
    default: {
      // Compile-time exhaustiveness guard: this assignment fails to type-check
      // when the SDK union grows a member the switch doesn't name. At runtime
      // the API can still send a value newer than the installed SDK types, so
      // log it and end the turn rather than failing the request.
      const _exhaustive: never = reason;
      logger.warn(
        { stopReason: _exhaustive },
        "unmapped Anthropic stop_reason; treating the turn as ended",
      );
      return "end_turn";
    }
  }
}
