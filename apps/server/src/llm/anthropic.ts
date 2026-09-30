import Anthropic, { BadRequestError } from "@anthropic-ai/sdk";
import { z } from "zod";
import { logger } from "../logger.js";
import { abortReasonOr } from "./abort.js";
import {
  hasOpenObject,
  hasRecursiveRef,
  hasTuple,
  restoreLiteralCasing,
  toStructuredOutputSchema,
} from "./anthropic-output-schema.js";
import { cacheMarker } from "./cache-marker.js";
import { extractText } from "./content.js";
import {
  MissingToolCallError,
  ProviderProtocolError,
  parseToolArgs,
  ToolArgsCutOffError,
} from "./errors.js";
import { definitionsOf } from "./json-schema.js";
import { withFailureLogging } from "./logging-fetch.js";
import { failChatSpan, recordChatUsage, startChatSpan } from "./otel.js";
import type { PrefixMismatchBehavior } from "./prefix-mismatch-behavior.js";
import type { LlmProvider } from "./provider.js";
import { canonicalPromptParts, withClearedToolResults } from "./tool-result-clearing.js";
import {
  type ChatOptions,
  type ChatParams,
  type ChatStreamFrame,
  type ContentBlock,
  type CountTokensParams,
  DEFAULT_MAX_TOKENS,
  type LlmResponse,
  type Message,
  type ResponseFormat,
  type StopReason,
  type ToolDefinition,
  type ToolResultClearing,
  type Usage,
} from "./types.js";

export interface AnthropicProviderOptions {
  /**
   * Transport for the SDK's requests — tests pass the wire recorder
   * (`src/test/wire-recorder.ts`). Wrapped in the failure logger exactly as
   * the default `globalThis.fetch` is.
   */
  fetch?: typeof fetch;
  /**
   * Whether the endpoint is Anthropic's own API, which gets the request
   * controls ({@link requestControls}). Defaults to whether the base URL the
   * SDK resolves is `api.anthropic.com`: an Anthropic-compatible third-party
   * endpoint may reject them. A test pointing at llmock, which records from
   * Anthropic's API, sets it.
   */
  firstParty?: boolean;
  /**
   * `llm_providers.attrs.prefixMismatchBehavior`, sent as
   * `thinking.block_binding` to the models that run the prefix check, on a
   * first-party endpoint. Absent sends no `thinking` parameter and keeps the
   * account's default.
   */
  prefixMismatchBehavior?: PrefixMismatchBehavior;
}

/** What the adapter's endpoint takes beyond a plain Messages request. */
interface Endpoint {
  firstParty: boolean;
  prefixMismatchBehavior: PrefixMismatchBehavior | undefined;
}

/**
 * Anthropic SDK adapter.
 *
 * Translates between our canonical types and the Anthropic Messages API,
 * through the SDK's beta namespace, which carries `context_management` and
 * the binding controls. The mapping is nearly 1:1 — Anthropic's format
 * inspired our canonical types.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  #client: Anthropic;
  #endpoint: Endpoint;

  constructor(apiKey: string, baseURL?: string, options?: AnthropicProviderOptions) {
    this.#client = new Anthropic({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      fetch: withFailureLogging(options?.fetch ?? globalThis.fetch, logger, this.name),
    });
    // The URL the SDK resolved, which falls back to `ANTHROPIC_BASE_URL` and
    // then to Anthropic's own for a missing or empty base URL.
    const firstParty = options?.firstParty ?? isAnthropicApi(this.#client.baseURL);
    const prefixMismatchBehavior = options?.prefixMismatchBehavior;
    if (prefixMismatchBehavior && !firstParty) {
      logger.warn(
        { baseURL: this.#client.baseURL, prefixMismatchBehavior },
        "ignoring prefixMismatchBehavior: the provider's endpoint isn't Anthropic's API, which is " +
          "the only one it goes to, so this provider keeps the endpoint's default",
      );
    }
    this.#endpoint = { firstParty, prefixMismatchBehavior };
  }

  chatStream(params: ChatParams, options?: ChatOptions): AsyncIterable<ChatStreamFrame> {
    if (params.responseFormat && params.tools?.length) {
      throw new Error("responseFormat and tools are mutually exclusive");
    }

    const anthropicParams = buildCreateParams(params, takesToolPath(params), this.#endpoint);
    const client = this.#client;
    const providerName = this.name;
    const signal = options?.signal;

    async function* generateFrames(): AsyncGenerator<ChatStreamFrame> {
      const span = startChatSpan(providerName, params.model);
      let completed = false;
      try {
        const stream = await client.beta.messages.create(
          { ...anthropicParams, stream: true },
          { signal },
        );

        // Track tool_use blocks by index for input accumulation
        const toolBlocks = new Map<number, { id: string; name: string; jsonChunks: string[] }>();
        // Track thinking blocks by index for content accumulation
        const thinkingBlocks = new Map<number, { signature: string; chunks: string[] }>();
        let model = "";
        let stopReason: StopReason = "end_turn";
        let usage: Usage = { inputTokens: 0, outputTokens: 0 };
        // A tool block whose arguments failed to parse, held until the stream
        // shows whether the output cap cut it off: a response that stops at
        // `max_tokens` with no further block did, and one that goes on to
        // another block wrote malformed JSON.
        let unparsed: ProviderProtocolError | undefined;

        for await (const event of stream) {
          // Once the signal fires, the SDK still yields the events it had
          // buffered from the current network chunk, then ends quietly.
          signal?.throwIfAborted();
          if (unparsed !== undefined) {
            if (event.type === "message_delta") {
              const cutOff = fromAnthropicStopReason(event.delta.stop_reason) === "max_tokens";
              throw cutOff ? new ToolArgsCutOffError(unparsed) : unparsed;
            }
            if (event.type === "content_block_start") throw unparsed;
            continue;
          }
          switch (event.type) {
            case "message_start":
              model = event.message.model;
              usage = fromAnthropicUsage(event.message.usage);
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
                toolBlocks.delete(event.index);
                let input: unknown;
                try {
                  input = parseToolArgs(
                    toolBlock.jsonChunks.join(""),
                    toolBlock.name,
                    "Anthropic streamed tool_use input",
                  );
                } catch (parseErr) {
                  if (!(parseErr instanceof ProviderProtocolError)) throw parseErr;
                  unparsed = parseErr;
                  break;
                }
                yield { type: "tool_start", id: toolBlock.id, name: toolBlock.name, input };
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

        signal?.throwIfAborted();
        if (unparsed !== undefined) throw unparsed;
        recordChatUsage(span, providerName, model, usage, stopReason);
        completed = true;
        yield { type: "done", meta: { stopReason, model, usage } };
      } catch (err) {
        completed = true;
        const cause = abortReasonOr(err, signal);
        failChatSpan(span, cause);
        throw cause;
      } finally {
        // Returned before completing: the consumer stopped early, and
        // leaving the SDK stream's loop above aborted the request.
        if (!completed) failChatSpan(span, new Error("chatStream consumer abandoned the stream"));
        span.end();
      }
    }

    return generateFrames();
  }

  /**
   * The request's input tokens, after the edits it asks for: the endpoint
   * applies `context_management` as it does on a message, and runs the same
   * prefix check, so the count carries the same controls.
   */
  async countTokens(params: CountTokensParams): Promise<number> {
    const built = buildCreateParams(
      { ...params, maxTokens: 1 },
      takesToolPath(params),
      this.#endpoint,
    );
    const countParams: Anthropic.Beta.Messages.MessageCountTokensParams = {
      model: built.model,
      messages: built.messages,
      ...(built.system && { system: built.system }),
      ...(built.tools && { tools: built.tools }),
      ...(built.output_config && { output_config: built.output_config }),
      ...(built.context_management && { context_management: built.context_management }),
      ...(built.thinking && { thinking: built.thinking }),
      ...(built.betas && { betas: built.betas }),
    };
    const result = await this.#client.beta.messages.countTokens(countParams);
    return result.input_tokens;
  }

  async chat(params: ChatParams, options?: ChatOptions): Promise<LlmResponse> {
    if (params.responseFormat && params.tools?.length) {
      throw new Error("responseFormat and tools are mutually exclusive");
    }

    const signal = options?.signal;
    const span = startChatSpan(this.name, params.model);
    try {
      const { response, toolPath } = await this.#create(clampForNonStreaming(params), signal);

      const usage = fromAnthropicUsage(response.usage);

      const stopReason = fromAnthropicStopReason(response.stop_reason);
      recordChatUsage(span, this.name, response.model, usage, stopReason);

      // A tool-path reply carries the JSON as the tool's input. Returned as
      // text, with `tool_use` read as `end_turn`, it matches a
      // structured-output reply; any other stop reason passes through.
      const format = params.responseFormat;
      const content = response.content.flatMap(fromAnthropicBlock);
      if (format && toolPath) {
        const toolUse = response.content.find((b) => b.type === "tool_use");
        if (toolUse && toolUse.type === "tool_use") {
          return {
            content: [{ type: "text", text: JSON.stringify(toolUse.input) }],
            stopReason: stopReason === "tool_use" ? "end_turn" : stopReason,
            model: response.model,
            usage,
          };
        }
        // `tool_choice: auto` lets the model answer in text instead. A cut-off
        // or refused reply passes through with its stop reason.
        if (stopReason === "end_turn") {
          throw new MissingToolCallError(format.name, {
            reply: extractText(content),
            instruction: callInstruction(format.name),
            usage,
          });
        }
      }

      return {
        content:
          format && !toolPath
            ? content.map((block) => withLiteralCasing(block, format, response.model))
            : content,
        stopReason,
        model: response.model,
        usage,
      };
    } catch (err) {
      const cause = abortReasonOr(err, signal);
      failChatSpan(span, cause);
      throw cause;
    } finally {
      span.end();
    }
  }

  /**
   * Send a non-streaming request. A structured-output schema past the
   * grammar's compile limits ({@link isGrammarLimitError}) goes once more on
   * the tool path: a pre-check can't foresee the internal grammar-size limit.
   */
  async #create(
    params: ChatParams,
    signal: AbortSignal | undefined,
  ): Promise<{ response: Anthropic.Beta.BetaMessage; toolPath: boolean }> {
    const send = (toolPath: boolean): Promise<Anthropic.Beta.BetaMessage> =>
      this.#client.beta.messages.create(buildCreateParams(params, toolPath, this.#endpoint), {
        signal,
      });
    const toolPath = takesToolPath(params);
    try {
      return { response: await send(toolPath), toolPath };
    } catch (err) {
      if (toolPath || params.responseFormat === undefined || !isGrammarLimitError(err)) throw err;
      logger.warn(
        { model: params.model, format: params.responseFormat.name, err },
        "structured output can't compile the schema, retrying on the tool path",
      );
      return { response: await send(true), toolPath: true };
    }
  }
}

// --- Params builder ---

/**
 * Ceiling on `max_tokens` for a non-streaming request, above which the
 * SDK throws `AnthropicError: Streaming is required…` client-side rather
 * than sending anything. It projects generation time as
 * `60min * max_tokens / 128_000` and refuses anything past its 10-minute
 * default timeout, so the ceiling is 21_333 — and only when no explicit
 * timeout is set, which is our case. `nonstreaming-ceiling.test.ts` pins
 * the boundary against the installed SDK.
 *
 * Streaming carries no such limit; `chatStream` passes the caller's cap
 * through untouched.
 */
export const MAX_NONSTREAMING_TOKENS = 21_333;

const warnedNonStreamingClamp = new Set<string>();

/**
 * Bring `maxTokens` under the non-streaming ceiling. Clamping over
 * setting an explicit client timeout: the SDK's reasoning holds — a 64k
 * non-streaming generation really can outlive an HTTP timeout — and a
 * timeout would silence the guard while holding the connection open.
 */
function clampForNonStreaming(params: ChatParams): ChatParams {
  const requested = params.maxTokens;
  if (requested === undefined || requested <= MAX_NONSTREAMING_TOKENS) return params;
  if (!warnedNonStreamingClamp.has(params.model)) {
    warnedNonStreamingClamp.add(params.model);
    logger.warn(
      { model: params.model, requested, clampedTo: MAX_NONSTREAMING_TOKENS },
      `clamping max_tokens to ${MAX_NONSTREAMING_TOKENS} for a non-streaming request to ` +
        `"${params.model}" — the SDK rejects a larger cap without streaming. Use chatStream to ` +
        `use the model's full output budget.`,
    );
  }
  return { ...params, maxTokens: MAX_NONSTREAMING_TOKENS };
}

const warnedSamplingModels = new Set<string>();

/**
 * The Messages API rejects sampling parameters (`temperature`, `top_p`,
 * `top_k`) with a 400 on Opus 4.7 and later and across the 5 series.
 * Sonnet 4.6 and Opus 4.6 still accept them, but the drop stays
 * unconditional: keying it on the model means a table of which ids accept
 * what, and that goes stale silently, 400ing the request when it does.
 *
 * `ChatParams.temperature` stays canonical because the OpenAI-compatible
 * adapter honours it. The warning tells a caller asking for determinism
 * that it wasn't granted.
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

// --- Request controls ---

/** Context editing, which carries `context_management`. */
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";

/**
 * Preserved thinking's binding controls: `input_transformations` on every
 * response, and `thinking.block_binding`, which is a 400 without it.
 */
export const BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";

/**
 * The models that run preserved thinking's prefix check, each adaptive by
 * default. Sonnet 5 accepts `block_binding` but runs no check, and Haiku 4.5
 * rejects `adaptive`, so neither is listed; a model missing from the list
 * loses only the field.
 */
const PREFIX_CHECKED_MODELS = ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"];

function runsPrefixCheck(model: string): boolean {
  return PREFIX_CHECKED_MODELS.some((id) => model === id || model.startsWith(`${id}-`));
}

function isAnthropicApi(baseURL: string): boolean {
  return URL.parse(baseURL)?.hostname === "api.anthropic.com";
}

/** The fields and betas every request for `params` carries beyond the Messages request itself. */
interface RequestControls {
  betas?: Anthropic.Beta.AnthropicBeta[];
  context_management?: Anthropic.Beta.BetaContextManagementConfig;
  thinking?: Anthropic.Beta.BetaThinkingConfigAdaptive;
}

/**
 * The request controls, which go to Anthropic's own API only: the edit intent
 * as `clear_tool_uses_20250919`, the binding-controls header, and
 * `block_binding` where the provider row sets a behaviour and the model runs
 * the check. `block_binding` goes with `adaptive`, the configuration those
 * models run anyway; never `between_tools`, which rejects it. A third-party
 * endpoint gets none of them, and its messages are cleared on the wire
 * instead ({@link wireMessages}).
 */
function requestControls(params: CountTokensParams, endpoint: Endpoint): RequestControls {
  if (!endpoint.firstParty) return {};
  const clearing = params.clearToolResults;
  const behavior = endpoint.prefixMismatchBehavior;
  return {
    betas: [...(clearing ? [CONTEXT_MANAGEMENT_BETA] : []), BINDING_CONTROLS_BETA],
    ...(clearing && { context_management: { edits: [toClearToolUses(clearing)] } }),
    ...(behavior &&
      runsPrefixCheck(params.model) && {
        thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: behavior } },
      }),
  };
}

/**
 * The messages the request sends. Anthropic's API clears on its server, so
 * it gets them as they are; a third-party endpoint gets Strategy 1 applied
 * on the wire ({@link withClearedToolResults}), triggered by a local
 * estimate. Its placeholders then rewrite earlier results as the cleared set
 * moves, which a route that enforces preserved thinking rejects.
 */
function wireMessages(params: CountTokensParams, endpoint: Endpoint): Message[] {
  if (endpoint.firstParty) return params.messages;
  return withClearedToolResults(params, (messages) =>
    canonicalPromptParts({ ...params, messages }),
  );
}

/**
 * Strategy 1 on Anthropic's server. The client keeps sending every result;
 * the server replaces each cleared one with a placeholder, and the
 * preserved-thinking check compares what was sent.
 */
function toClearToolUses(
  clearing: ToolResultClearing,
): Anthropic.Beta.BetaClearToolUses20250919Edit {
  return {
    type: "clear_tool_uses_20250919",
    trigger: { type: "input_tokens", value: clearing.triggerTokens },
    keep: { type: "tool_uses", value: clearing.keep },
    clear_at_least: { type: "input_tokens", value: clearing.clearAtLeastTokens },
  };
}

/**
 * The request for `params`. With `toolPath`, a `responseFormat` goes as a
 * synthetic tool rather than as structured outputs.
 */
function buildCreateParams(
  params: ChatParams,
  toolPath: boolean,
  endpoint: Endpoint,
): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  dropSamplingParams(params);
  const controls = requestControls(params, endpoint);
  const messages = wireMessages(params, endpoint).map(toAnthropicMessage);

  // A structured-output call is one-shot — nothing re-sends its transcript —
  // so it keeps the default markers whatever the intent.
  const marker = cacheMarker(params.responseFormat ? undefined : params.cache);

  // System prompt as content block array with cache_control on the last block.
  // Tools + system are static per conversation — caching saves 90% on reads.
  // Omit the block when there's no prompt: Anthropic rejects an empty-text
  // content block, and a null-persona sub-agent passes system: "".
  const systemBlocks: Anthropic.Beta.BetaTextBlockParam[] =
    params.system.trim().length > 0
      ? [{ type: "text", text: params.system, cache_control: marker }]
      : [];

  const format = params.responseFormat;
  if (format) {
    const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;
    if (!toolPath) {
      return {
        model: params.model,
        max_tokens: maxTokens,
        ...(systemBlocks.length > 0 && { system: systemBlocks }),
        messages,
        output_config: {
          format: { type: "json_schema", schema: toStructuredOutputSchema(format.schema) },
        },
        ...controls,
      };
    }

    // The system prompt asks for the call: forcing it (`tool_choice` of
    // type `tool` or `any`) is a 400 on Opus 5.5, Sonnet 5.5 and Fable 5.1.
    const syntheticTool = toAnthropicTool({
      name: format.name,
      description: "Respond with structured data matching the schema.",
      parameters: format.schema,
    });
    syntheticTool.cache_control = { type: "ephemeral" };
    return {
      model: params.model,
      max_tokens: maxTokens,
      system: [...systemBlocks, { type: "text", text: callInstruction(format.name) }],
      messages,
      tools: [syntheticTool],
      ...controls,
    };
  }

  // Add cache_control to the last tool (caches all tools as a prefix)
  const tools = params.tools?.length ? params.tools.map(toAnthropicTool) : undefined;
  if (tools && tools.length > 0) {
    const last = tools[tools.length - 1];
    if (last) tools[tools.length - 1] = { ...last, cache_control: marker };
  }

  const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;

  // No `thinking` parameter beyond `block_binding`'s: each model applies its
  // own default, which is adaptive thinking on Sonnet 5 and the rest of the 5
  // series. Explicit depth control belongs in `output_config.effort`, which
  // nothing needs yet. Thinking blocks that come back are translated by
  // `toAnthropicMessage` / `toCanonicalBlock` either way.
  //
  // With a cache intent, top-level `cache_control` turns on automatic
  // caching: the server puts a breakpoint on the last cacheable block and
  // moves it forward as the transcript grows, so each request reads what the
  // previous one wrote. It takes the third of four breakpoint slots; the
  // tools and system markers stay as read points that survive a miss further
  // down.
  return {
    model: params.model,
    max_tokens: maxTokens,
    ...(systemBlocks.length > 0 && { system: systemBlocks }),
    messages,
    ...(tools && { tools }),
    ...(params.cache && { cache_control: marker }),
    ...controls,
  };
}

// --- Structured output ---

/**
 * Whether a `responseFormat` request takes the tool path, a synthetic tool
 * carrying the schema, rather than structured outputs: its schema is one the
 * grammar can't express, with an open node ({@link hasOpenObject}), a
 * recursive `$ref` ({@link hasRecursiveRef}) or a tuple ({@link hasTuple}).
 */
function takesToolPath(params: ChatParams): boolean {
  const schema = params.responseFormat?.schema;
  return (
    schema !== undefined && (hasOpenObject(schema) || hasRecursiveRef(schema) || hasTuple(schema))
  );
}

/** Substrings of the 400 messages for a schema past the grammar's compile limits. */
const GRAMMAR_LIMIT_MESSAGES = [
  "Schema is too complex for compilation",
  "The compiled grammar is too large",
  "too many optional parameters",
  "too many parameters with union types",
  "pattern is too complex for structured output",
] as const;

/** The message in an Anthropic API error's body. */
const ErrorMessageBodySchema = z.object({ error: z.object({ message: z.string() }) });

/** Whether the client's error is a 400 for a schema past the grammar's compile limits. */
function isGrammarLimitError(err: unknown): boolean {
  if (!(err instanceof BadRequestError) || err.type !== "invalid_request_error") return false;
  const body = ErrorMessageBodySchema.safeParse(err.error);
  return (
    body.success &&
    GRAMMAR_LIMIT_MESSAGES.some((message) => body.data.error.message.includes(message))
  );
}

/**
 * A structured-output text block with its `enum` and `const` values in the
 * schema's capitalization ({@link restoreLiteralCasing}). Text that isn't
 * JSON, as in a cut-off or refused reply, passes through for the caller to
 * judge.
 */
function withLiteralCasing(
  block: ContentBlock,
  format: ResponseFormat,
  model: string,
): ContentBlock {
  if (block.type !== "text") return block;
  let reply: unknown;
  try {
    reply = JSON.parse(block.text);
  } catch {
    return block;
  }
  const restored = restoreLiteralCasing(format.schema, reply);
  if (restored === reply) return block;
  logger.debug(
    { model, format: format.name },
    "restored the capitalization of enum or const values in a structured-output reply",
  );
  return { ...block, text: JSON.stringify(restored) };
}

/** The tool path's request for its call, in the system prompt and in a re-ask. */
function callInstruction(name: string): string {
  return `Respond by calling the ${name} tool.`;
}

/**
 * Canonical {@link Usage} from Anthropic's. `input_tokens` counts only the
 * tokens after the last cache breakpoint; the prompt's total adds back what
 * was read from and written to the cache.
 */
function fromAnthropicUsage(usage: Anthropic.Beta.BetaUsage): Usage {
  const cacheRead = usage.cache_read_input_tokens;
  const cacheCreation = usage.cache_creation_input_tokens;
  return {
    inputTokens: usage.input_tokens + (cacheRead ?? 0) + (cacheCreation ?? 0),
    outputTokens: usage.output_tokens,
    ...(cacheRead != null && { cacheReadTokens: cacheRead }),
    ...(cacheCreation != null && { cacheCreationTokens: cacheCreation }),
  };
}

// --- To Anthropic format ---

function toAnthropicMessage(msg: Message): Anthropic.Beta.BetaMessageParam {
  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content };
  }

  return {
    role: msg.role,
    content: msg.content.map(toAnthropicBlock),
  };
}

function toAnthropicBlock(block: ContentBlock): Anthropic.Beta.BetaContentBlockParam {
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
      const result: Anthropic.Beta.BetaToolResultBlockParam = {
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

/** The tool with its schema's definitions, without which its `$ref`s dangle. */
function toAnthropicTool(tool: ToolDefinition): Anthropic.Beta.BetaTool {
  const { properties, required } = tool.parameters;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object",
      ...(properties !== undefined && { properties }),
      ...(required !== undefined && { required }),
      ...definitionsOf(tool.parameters),
    },
  };
}

// --- From Anthropic format ---

function fromAnthropicBlock(block: Anthropic.Beta.BetaContentBlock): ContentBlock[] {
  switch (block.type) {
    case "text":
      return [{ type: "text", text: block.text }];
    case "tool_use":
      return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
    case "thinking":
      return [{ type: "thinking", thinking: block.thinking, signature: block.signature }];
    default:
      // Block types we don't model (server_tool_use, redacted_thinking, …).
      // Dropping is right for blocks the API doesn't want echoed back, and
      // wrong for `redacted_thinking`, which has to make the round trip
      // like any other thinking block — carrying it needs a canonical
      // variant and its JSONB schema, tracked in todo.md. Log so a type
      // that starts appearing is visible here rather than as an ordering
      // error on the next request.
      logUnmappedBlockOnce(block.type);
      return [];
  }
}

const loggedUnmappedBlocks = new Set<string>();

function logUnmappedBlockOnce(type: string): void {
  if (loggedUnmappedBlocks.has(type)) return;
  loggedUnmappedBlocks.add(type);
  logger.warn(
    { blockType: type },
    `dropping an Anthropic content block of type "${type}" — it has no canonical equivalent, ` +
      `so it will not be sent back in history.`,
  );
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
function fromAnthropicStopReason(reason: Anthropic.Beta.BetaStopReason | null): StopReason {
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
    case "compaction":
      // Server-side compaction paused the turn after writing its summary.
      // The adapter sends no compaction edit, so this ends the turn like
      // `pause_turn` should it ever arrive.
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
