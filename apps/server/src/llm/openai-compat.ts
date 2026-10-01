import type Anthropic from "@anthropic-ai/sdk";
import { Result } from "neverthrow";
import OpenAI from "openai";
import * as R from "remeda";
import { logger } from "../logger.js";
import { abortReasonOr } from "./abort.js";
import type { CacheDialect } from "./cache-dialect.js";
import { cacheMarker } from "./cache-marker.js";
import { type ProviderProtocolError, parseToolArgs, ToolArgsCutOffError } from "./errors.js";
import type { ExtraBody } from "./extra-body.js";
import { RefusalError } from "./fallback.js";
import { withFailureLogging } from "./logging-fetch.js";
import { fitsStrictMode } from "./openai-output-schema.js";
import { failChatSpan, recordChatUsage, recordReasoningChars, startChatSpan } from "./otel.js";
import type { LlmProvider } from "./provider.js";
import {
  cl100k,
  type TextTokens,
  textTokens,
  withClearedToolResults,
} from "./tool-result-clearing.js";
import {
  type CacheIntent,
  type ChatOptions,
  type ChatParams,
  type ChatStreamFrame,
  type ContentBlock,
  type CountTokensParams,
  DEFAULT_MAX_TOKENS,
  type LlmResponse,
  type Message,
  type StopReason,
  type TextBlock,
  type ToolDefinition,
  type Usage,
} from "./types.js";

/**
 * Upper bound on inlined text-document content per document, in characters.
 * Matches `MAX_READ_LENGTH` in file-tools.ts. Telegram's Bot API delivers
 * files up to 20MB, which would blow past most context windows when
 * inlined verbatim — cap at the same threshold the read_file tool uses.
 */
const MAX_INLINED_DOC_CHARS = 100_000;

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseURL: string;
  headers?: Record<string, string>;
  /** Which hints a request's cache intent puts on the wire — see {@link CacheDialect}. */
  cacheDialect: CacheDialect;
  /**
   * The model's operator-set request fields (`model_providers.extra_body`),
   * sent on every chat-completions request. None of its keys is one the
   * adapter sets — `ExtraBodySchema` refuses those.
   */
  extraBody?: ExtraBody;
  /**
   * Transport for the SDK's requests — tests pass the wire recorder
   * (`src/test/wire-recorder.ts`). Wrapped in the failure logger exactly as
   * the default `globalThis.fetch` is.
   */
  fetch?: typeof fetch;
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
  #cacheDialect: CacheDialect;
  #extraBody: ExtraBody;

  constructor(name: string, config: OpenAICompatibleConfig) {
    this.name = name;
    this.#cacheDialect = config.cacheDialect;
    this.#extraBody = config.extraBody ?? {};
    this.#client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultHeaders: config.headers,
      fetch: withFailureLogging(config.fetch ?? globalThis.fetch, logger, name),
    });
  }

  /**
   * The request's prompt tokens, after the tool-result clearing it asks for.
   * Once the sum passes `countUpTo`, it stops and returns the sum so far.
   */
  async countTokens(params: CountTokensParams): Promise<number> {
    // One memory for both, so the count reads the slices the clearing already encoded.
    const tokens = textTokens(cl100k());
    const messages = clearedMessages(params, tokens);
    let sum = 0;
    for (const part of promptParts(tokens, { ...params, messages })) {
      sum += part;
      if (params.countUpTo !== undefined && sum > params.countUpTo) return sum;
    }
    return sum;
  }

  async chat(params: ChatParams, options?: ChatOptions): Promise<LlmResponse> {
    if (params.responseFormat && params.tools?.length) {
      throw new Error("responseFormat and tools are mutually exclusive");
    }

    const hints = cacheHints(this.#cacheDialect, params);
    const signal = options?.signal;
    const span = startChatSpan(this.name, params.model);
    try {
      const createParams: OpenAI.ChatCompletionCreateParamsNonStreaming &
        CacheHintFields &
        Record<string, unknown> = {
        // First, so a field the adapter builds always wins.
        ...this.#extraBody,
        model: params.model,
        ...modelFamilyParams(params.model, params),
        messages: buildMessages(
          params.system,
          clearedMessages(params, textTokens(cl100k())),
          hints.systemMarker,
        ),
        ...hints.fields,
      };

      if (params.tools?.length) {
        createParams.tools = params.tools.map(toOpenAITool);
      }

      // A schema outside strict mode's subset goes with `strict: false`: the
      // schema still guides the reply, and the caller validates it.
      if (params.responseFormat) {
        createParams.response_format = {
          type: "json_schema",
          json_schema: {
            name: params.responseFormat.name,
            schema: params.responseFormat.schema,
            strict: fitsStrictMode(params.responseFormat.schema),
          },
        };
      }

      const response = await this.#client.chat.completions.create(
        createParams,
        requestOptions(hints, signal),
      );

      const choice = response.choices[0];
      if (!choice) throw new Error("No choices in response");

      const usage: Usage = response.usage
        ? fromOpenAIUsage(response.usage)
        : { inputTokens: 0, outputTokens: 0 };
      const stopReason = fromOpenAIFinishReason(choice.finish_reason);
      recordChatUsage(span, this.name, response.model, usage, stopReason);
      recordReasoningChars(span, reasoningText(choice.message)?.length ?? 0);

      return {
        content: fromOpenAIMessage(choice.message, stopReason),
        stopReason,
        model: response.model,
        usage,
      };
    } catch (err) {
      const mapped = abortReasonOr(toRefusalErrorIfMatches(err) ?? err, signal);
      failChatSpan(span, mapped);
      throw mapped;
    } finally {
      span.end();
    }
  }

  chatStream(params: ChatParams, options?: ChatOptions): AsyncIterable<ChatStreamFrame> {
    if (params.responseFormat && params.tools?.length) {
      throw new Error("responseFormat and tools are mutually exclusive");
    }

    const client = this.#client;
    const hints = cacheHints(this.#cacheDialect, params);
    const extraBody = this.#extraBody;
    const providerName = this.name;
    const signal = options?.signal;

    async function* generateFrames(): AsyncGenerator<ChatStreamFrame> {
      const span = startChatSpan(providerName, params.model);
      let completed = false;
      // Characters of reasoning the endpoint streamed and the adapter doesn't
      // forward. Stamped on the span however the stream ends, so a turn cut
      // off mid-thought still shows how long the model had been thinking.
      let reasoningChars = 0;
      try {
        const messages = buildMessages(
          params.system,
          clearedMessages(params, textTokens(cl100k())),
          hints.systemMarker,
        );
        // Map content-policy 400s to RefusalError at the create-time boundary
        // before they propagate to FallbackLlmProvider. `.catch()` keeps the
        // narrow Stream<...> type from the streaming overload — a try/catch
        // would widen `stream` to the ChatCompletion|Stream union.
        const stream = await client.chat.completions
          .create(
            {
              // First, so a field the adapter builds always wins.
              ...extraBody,
              model: params.model,
              ...modelFamilyParams(params.model, params),
              messages,
              ...hints.fields,
              ...(params.tools?.length && { tools: params.tools.map(toOpenAITool) }),
              stream: true,
              stream_options: { include_usage: true },
            },
            requestOptions(hints, signal),
          )
          .catch((err: unknown) => {
            throw toRefusalErrorIfMatches(err) ?? err;
          });

        let model = params.model;
        let usage: Usage = { inputTokens: 0, outputTokens: 0 };
        let finishReason: StopReason = "end_turn";

        // Accumulate tool call arguments per index (streamed as deltas)
        const toolCalls = new Map<number, { id: string; name: string; argumentChunks: string[] }>();

        for await (const chunk of stream) {
          if (chunk.model) model = chunk.model;

          // Usage comes in the final chunk (stream_options: include_usage)
          if (chunk.usage) {
            usage = fromOpenAIUsage(chunk.usage);
          }

          const delta = chunk.choices[0]?.delta;
          const reason = chunk.choices[0]?.finish_reason;

          if (reason) {
            finishReason = fromOpenAIFinishReason(reason);
          }

          if (!delta) continue;

          reasoningChars += reasoningText(delta)?.length ?? 0;

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

        // The SDK ends its stream quietly when the signal fires.
        signal?.throwIfAborted();

        // Yield accumulated tool calls as complete tool_start events.
        const calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
        for (const [position, call] of calls.entries()) {
          const input = parseCallArgs(
            call.argumentChunks.join(""),
            call.name,
            "OpenAI-compatible streamed tool_calls arguments",
            finishReason === "max_tokens" && position === calls.length - 1,
          );
          if (input.isErr()) throw input.error;
          yield { type: "tool_start", id: call.id, name: call.name, input: input.value };
        }

        recordChatUsage(span, providerName, model, usage, finishReason);
        completed = true;
        yield { type: "done", meta: { stopReason: finishReason, model, usage } };
      } catch (err) {
        completed = true;
        const cause = abortReasonOr(err, signal);
        failChatSpan(span, cause);
        throw cause;
      } finally {
        // Returned before completing: the consumer stopped early. Mid-SDK
        // stream, leaving its loop above aborted the request.
        if (!completed) failChatSpan(span, new Error("chatStream consumer abandoned the stream"));
        recordReasoningChars(span, reasoningChars);
        span.end();
      }
    }

    return generateFrames();
  }
}

// --- Model-family parameters ---

/** The request fields whose accepted form depends on the model's family. */
type FamilyParams = ({ max_tokens: number } | { max_completion_tokens: number }) & {
  reasoning_effort?: "none";
  temperature?: number;
};

/**
 * The output cap, reasoning effort and temperature for `model`'s family on
 * Chat Completions — see design/providers.md → Architecture.
 */
export function modelFamilyParams(
  model: string,
  request: Pick<ChatParams, "maxTokens" | "temperature" | "tools">,
): FamilyParams {
  const cap = request.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = request.temperature === undefined ? {} : { temperature: request.temperature };
  const family = openAIFamily(model);
  if (family === "other") return { max_tokens: cap, ...temperature };
  if (
    family === "reasoning-with-none" &&
    (request.tools?.length || request.temperature !== undefined)
  ) {
    return { max_completion_tokens: cap, reasoning_effort: "none", ...temperature };
  }
  if (request.temperature !== undefined) warnDroppedTemperature(model, request.temperature);
  return { max_completion_tokens: cap };
}

/**
 * `reasoning` for OpenAI's reasoning models (the o-series, GPT-5 onward and
 * the `chat-latest` ids, by bare or fine-tuned id), and `reasoning-with-none`
 * for those with a `none` effort: GPT-5.1 onward, except the Astra tier and
 * `chat-latest`.
 */
function openAIFamily(model: string): "other" | "reasoning" | "reasoning-with-none" {
  const id = model.replace(/^ft:/, "");
  if (/^o\d/.test(id) || /^(gpt-[\d.]+-)?chat-latest$/.test(id)) return "reasoning";
  const version = /^gpt-(\d+)(?:\.(\d+))?/.exec(id);
  if (!version) return "other";
  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);
  if (major < 5) return "other";
  if (/^gpt-[\d.]+-astra/.test(id)) return "reasoning";
  return major > 5 || minor >= 1 ? "reasoning-with-none" : "reasoning";
}

const warnedTemperatureModels = new Set<string>();

function warnDroppedTemperature(model: string, temperature: number): void {
  if (warnedTemperatureModels.has(model)) return;
  warnedTemperatureModels.add(model);
  logger.warn(
    { model, temperature },
    `dropping temperature for "${model}" — OpenAI's reasoning models take one only at ` +
      `reasoning effort "none", which this model doesn't have.`,
  );
}

// --- Cache hints ---

/**
 * The request fields a cache intent can set: OpenAI's `prompt_cache_key`, and
 * OpenRouter's `session_id` and top-level `cache_control` (Anthropic's
 * automatic caching, passed through to Claude), which the SDK doesn't type.
 */
interface CacheHintFields
  extends Pick<OpenAI.ChatCompletionCreateParamsNonStreaming, "prompt_cache_key"> {
  session_id?: string;
  cache_control?: Anthropic.CacheControlEphemeral;
}

/** What one request carries for its cache intent, in its endpoint's dialect. */
interface CacheHints {
  fields: CacheHintFields;
  headers: Record<string, string> | undefined;
  /** The system message's `cache_control`, on models that honour markers. */
  systemMarker: Anthropic.CacheControlEphemeral | undefined;
}

const NO_HINTS: CacheHints = { fields: {}, headers: undefined, systemMarker: undefined };

/**
 * Map a request's cache intent onto its endpoint's dialect (see
 * design/prompt-caching.md → Adapter mapping). A structured-output call is
 * one-shot — nothing re-sends its transcript — so it maps as if it had no
 * intent, as on the Anthropic adapter. Retention reaches Claude only: OpenAI
 * and xAI keep entries for as long as they choose.
 */
function cacheHints(dialect: CacheDialect, params: ChatParams): CacheHints {
  const intent = params.responseFormat ? undefined : params.cache;
  switch (dialect) {
    case "none":
      return NO_HINTS;
    case "openai":
      return intent ? { ...NO_HINTS, fields: { prompt_cache_key: intent.key } } : NO_HINTS;
    case "xai":
      return intent ? { ...NO_HINTS, headers: { "x-grok-conv-id": intent.key } } : NO_HINTS;
    case "openrouter":
      return openRouterHints(params.model, intent);
  }
}

/**
 * OpenRouter's `session_id` keeps a conversation on one upstream, and so on
 * one cache, on every model. Markers go only where they take effect. Claude
 * gets the system marker, and for a transcript the top-level automatic
 * breakpoint, both at the intent's TTL. Gemini and Qwen get the system marker
 * alone, with no TTL, as neither takes one; on Gemini a tail marker that moves
 * every request makes OpenRouter write a new cache each time without reading
 * the last one.
 */
function openRouterHints(model: string, intent: CacheIntent | undefined): CacheHints {
  const session = intent ? { session_id: intent.key } : {};
  switch (markerFamily(model)) {
    case "anthropic": {
      const marker = cacheMarker(intent);
      return {
        fields: { ...session, ...(intent && { cache_control: marker }) },
        headers: undefined,
        systemMarker: marker,
      };
    }
    case "google":
    case "qwen":
      return { fields: session, headers: undefined, systemMarker: { type: "ephemeral" } };
    case undefined:
      return { ...NO_HINTS, fields: session };
  }
}

/**
 * The OpenRouter model families whose upstreams cache at `cache_control`
 * markers: Claude, Gemini, and Qwen on Alibaba, which caches only at them.
 * The rest (OpenAI, xAI, DeepSeek, …) cache automatically. A leading `~`
 * marks a family alias (`~anthropic/claude-sonnet-latest`).
 */
function markerFamily(model: string): "anthropic" | "google" | "qwen" | undefined {
  const slug = model.startsWith("~") ? model.slice(1) : model;
  if (slug.startsWith("anthropic/")) return "anthropic";
  if (slug.startsWith("google/")) return "google";
  if (slug.startsWith("qwen/")) return "qwen";
  return undefined;
}

/** The request's cache headers and the caller's abort signal. */
function requestOptions(hints: CacheHints, signal: AbortSignal | undefined): OpenAI.RequestOptions {
  return { ...(hints.headers && { headers: hints.headers }), signal };
}

// --- Token estimation ---

/** Message framing overhead (role, separators). */
const MESSAGE_FRAMING_TOKENS = 4;

/**
 * Images: ~85 tokens base for low-detail, more for high-detail.
 * Conservative estimate since we don't know the detail setting.
 */
const IMAGE_TOKENS = 85;

const REPLY_PRIMING_TOKENS = 3;

/**
 * The request's prompt tokens, as sent, a slice at a time: each message as it
 * reaches the wire, with its framing, then each tool definition and the reply
 * priming.
 */
function* promptParts(
  tokens: TextTokens,
  params: Pick<CountTokensParams, "system" | "messages" | "tools">,
): Generator<number> {
  for (const msg of buildMessages(params.system, params.messages, undefined)) {
    yield* messageParts(tokens, msg);
  }
  for (const tool of params.tools ?? []) yield* tokens(JSON.stringify(tool));
  yield REPLY_PRIMING_TOKENS;
}

// --- Tool-result clearing ---

/**
 * The request's messages with its Strategy 1 intent applied on the wire,
 * past the trigger by this adapter's own count. These routes replay no
 * reasoning, so a moving cleared set costs cache hits and nothing else.
 */
function clearedMessages(params: CountTokensParams, tokens: TextTokens): Message[] {
  return withClearedToolResults(
    params,
    (messages, sliceTokens) => promptParts(sliceTokens, { ...params, messages }),
    tokens,
  );
}

/** A tool result is a `tool` message with string content, so the content term covers it. */
function* messageParts(
  tokens: TextTokens,
  msg: OpenAI.ChatCompletionMessageParam,
): Generator<number> {
  yield MESSAGE_FRAMING_TOKENS;
  const content = msg.content;
  if (typeof content === "string") {
    yield* tokens(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "text") yield* tokens(part.text);
      else if (part.type === "image_url") yield IMAGE_TOKENS;
    }
  }
  if (msg.role === "assistant" && msg.tool_calls) {
    for (const call of msg.tool_calls) {
      if (call.type !== "function") continue;
      yield* tokens(call.function.name);
      yield* tokens(call.function.arguments);
    }
  }
}

// --- Message building ---

function buildMessages(
  system: string,
  messages: Message[],
  systemMarker: Anthropic.CacheControlEphemeral | undefined,
): OpenAI.ChatCompletionMessageParam[] {
  // Omit the system message entirely when blank — a null-persona sub-agent
  // passes system: "". An empty system block is rejected downstream by stricter
  // servers (vLLM/llama.cpp) and, on the OpenRouter → Anthropic caching path, by
  // Anthropic itself; mirrors the Anthropic adapter's omit-when-empty behaviour.
  const systemMessages: OpenAI.ChatCompletionMessageParam[] = [];
  if (system.trim().length > 0) {
    // A marker needs a content block to sit on, so a marked system prompt
    // goes as a one-block array.
    if (systemMarker) {
      const systemPart: OpenAI.ChatCompletionContentPartText & {
        cache_control: Anthropic.CacheControlEphemeral;
      } = { type: "text", text: system, cache_control: systemMarker };
      systemMessages.push({ role: "system", content: [systemPart] });
    } else {
      systemMessages.push({ role: "system", content: system });
    }
  }

  return [...systemMessages, ...mergeConsecutiveUserMessages(messages.flatMap(toOpenAIMessages))];
}

/**
 * `messages` with each run of adjacent user messages joined into one, since
 * strict-alternation chat templates reject two in a row. The continuation
 * prompt follows the turn's own row, and dropping a thinking-only assistant
 * turn leaves its neighbours adjacent.
 */
function mergeConsecutiveUserMessages(
  messages: ReadonlyArray<OpenAI.ChatCompletionMessageParam>,
): OpenAI.ChatCompletionMessageParam[] {
  // The accumulator is local, so pushing onto it keeps the merge linear.
  return R.reduce(
    messages,
    (out: OpenAI.ChatCompletionMessageParam[], msg) => {
      const prev = out.at(-1);
      if (prev?.role === "user" && msg.role === "user") {
        out[out.length - 1] = { role: "user", content: joinUserContent(prev.content, msg.content) };
      } else {
        out.push(msg);
      }
      return out;
    },
    [],
  );
}

/**
 * Two user messages' content as one. Text meeting text across the join is
 * separated by a blank line, whether both sides are strings or parts; an
 * image at the join separates them already.
 */
function joinUserContent(
  first: OpenAI.ChatCompletionUserMessageParam["content"],
  second: OpenAI.ChatCompletionUserMessageParam["content"],
): OpenAI.ChatCompletionUserMessageParam["content"] {
  if (typeof first === "string" && typeof second === "string") return `${first}\n\n${second}`;
  const left = userParts(first);
  const right = userParts(second);
  const last = left.at(-1);
  const next = right[0];
  if (last?.type === "text" && next?.type === "text") {
    return [
      ...left.slice(0, -1),
      { type: "text", text: `${last.text}\n\n${next.text}` },
      ...right.slice(1),
    ];
  }
  return [...left, ...right];
}

function userParts(
  content: OpenAI.ChatCompletionUserMessageParam["content"],
): OpenAI.ChatCompletionContentPart[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/** The Chat Completions messages one canonical message becomes — none, one, or several. */
function toOpenAIMessages(msg: Message): OpenAI.ChatCompletionMessageParam[] {
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }

  // Content blocks — handle tool_use and tool_result specially
  if (msg.role === "assistant") {
    // Skip ThinkingBlock — not supported by OpenAI-compatible endpoints
    const textBlocks = msg.content.filter((b) => b.type === "text");
    const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");

    const textContent = textBlocks.map((b) => b.text).join("");
    const toolCalls = toolUseBlocks.map((b) => ({
      id: b.id,
      type: "function" as const,
      function: {
        name: b.name,
        arguments: JSON.stringify(b.input),
      },
    }));

    // OpenAI rejects `{role:"assistant", content: null}` with no tool_calls.
    // An assistant turn whose only content was thinking (now stripped, or
    // never visible to OpenAI-compatible endpoints) carries no information
    // the model can use — drop it rather than send a malformed message.
    if (textContent === "" && toolCalls.length === 0) {
      return [];
    }

    return [
      {
        role: "assistant",
        content: textContent || null,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      },
    ];
  }

  // User message — may contain tool_result, text, image, and document blocks
  const toolResults = msg.content.filter((b) => b.type === "tool_result");
  const textBlocks = msg.content.filter((b) => b.type === "text");
  const imageBlocks = msg.content.filter((b) => b.type === "image");
  const documentBlocks = msg.content.filter((b) => b.type === "document");

  // Tool results become separate "tool" role messages
  const toolMessages: OpenAI.ChatCompletionToolMessageParam[] = toolResults.map((tr) => ({
    role: "tool",
    tool_call_id: tr.toolUseId,
    content: tr.content,
  }));

  // Documents: most OpenAI-compatible Chat Completions endpoints don't
  // accept document content parts. Inline text/* documents into a text
  // block so the model still sees them; binary documents (PDFs etc.)
  // get a stub note. Only Anthropic gets the rich `document` block via
  // its own adapter.
  const documentTextBlocks: TextBlock[] = documentBlocks.flatMap((d) => {
    if (d.mediaType.startsWith("text/") && d.source === "base64") {
      // Pre-decode slice: cap base64 input before allocating its UTF-8
      // expansion so a 20MB Telegram upload doesn't materialize 30MB of
      // string memory just to be truncated. base64 ratio is 4 chars per
      // 3 bytes; round to a multiple of 4 to keep the trailing block
      // intact (an unaligned slice can produce U+FFFD garbage at the
      // tail, which ruins the elision marker).
      const maxBase64 = Math.ceil((MAX_INLINED_DOC_CHARS * 4) / 3 / 4) * 4;
      const truncated = d.data.length > maxBase64;
      const slice = truncated ? d.data.slice(0, maxBase64) : d.data;
      let decoded = Buffer.from(slice, "base64").toString("utf-8");
      if (decoded.length > MAX_INLINED_DOC_CHARS) {
        decoded = decoded.slice(0, MAX_INLINED_DOC_CHARS);
      }
      if (truncated) {
        decoded += `\n\n[Content truncated at ${MAX_INLINED_DOC_CHARS} characters]`;
      }
      const label = d.name ?? d.mediaType;
      return [{ type: "text", text: `[document: ${label}]\n${decoded}` }];
    }
    return [
      {
        type: "text",
        text: `[document: ${d.name ?? d.mediaType} — binary content not supported on this provider]`,
      },
    ];
  });
  const allTextBlocks = [...textBlocks, ...documentTextBlocks];

  if (allTextBlocks.length === 0 && imageBlocks.length === 0) {
    return toolMessages;
  }

  // Text + images → multipart content array
  const parts: OpenAI.ChatCompletionContentPart[] = [
    ...allTextBlocks.map(
      (tb): OpenAI.ChatCompletionContentPartText => ({
        type: "text",
        text: tb.text,
      }),
    ),
    ...imageBlocks.map((ib): OpenAI.ChatCompletionContentPartImage => {
      const url = ib.source === "url" ? ib.data : `data:${ib.mediaType};base64,${ib.data}`;
      return { type: "image_url", image_url: { url } };
    }),
  ];
  return [
    ...toolMessages,
    {
      role: "user",
      content: imageBlocks.length > 0 ? parts : allTextBlocks.map((b) => b.text).join(""),
    },
  ];
}

// --- Tool definition mapping ---

function toOpenAITool(tool: ToolDefinition): OpenAI.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

// --- Response mapping ---

/**
 * Canonical {@link Usage} from a Chat Completions usage block. `prompt_tokens`
 * already includes cached tokens, so it stays the total; reads and writes come
 * from `prompt_tokens_details` (`cached_tokens`, and `cache_write_tokens` on
 * OpenRouter and GPT-5.6+). A count a compatible server omits reads as zero:
 * the loop sums these into an integer column.
 */
function fromOpenAIUsage(usage: OpenAI.CompletionUsage): Usage {
  const details = usage.prompt_tokens_details;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    ...(details?.cached_tokens != null && { cacheReadTokens: details.cached_tokens }),
    ...(details?.cache_write_tokens != null && {
      cacheCreationTokens: details.cache_write_tokens,
    }),
    ...(reasoningTokens != null && { reasoningTokens }),
  };
}

/**
 * The reasoning text a message or stream delta carries outside `content`:
 * `reasoning_content` (DeepSeek, Venice, vLLM) or `reasoning` (OpenRouter).
 * Neither is in the OpenAI SDK's types. The adapter doesn't forward it; it
 * is measured so a long think is visible on the span.
 */
function reasoningText(part: object): string | undefined {
  if ("reasoning_content" in part && typeof part.reasoning_content === "string") {
    return part.reasoning_content;
  }
  if ("reasoning" in part && typeof part.reasoning === "string") return part.reasoning;
  return undefined;
}

function fromOpenAIMessage(
  message: OpenAI.ChatCompletionMessage,
  stopReason: StopReason,
): ContentBlock[] {
  const text: ContentBlock[] = message.content ? [{ type: "text", text: message.content }] : [];

  const calls = (message.tool_calls ?? []).filter((tc) => tc.type === "function");
  const toolUses = Result.combine(
    calls.map((tc, position) =>
      parseCallArgs(
        tc.function.arguments,
        tc.function.name,
        "OpenAI-compatible non-streaming tool_calls arguments",
        stopReason === "max_tokens" && position === calls.length - 1,
      ).map(
        (input): ContentBlock => ({ type: "tool_use", id: tc.id, name: tc.function.name, input }),
      ),
    ),
  );
  if (toolUses.isErr()) throw toolUses.error;

  return [...text, ...toolUses.value];
}

/**
 * Parse one call's arguments. `lastCallAtCap` marks the call the output cap
 * could have cut off — the response's final call when it stopped at
 * `max_tokens` — so a parse failure there is unfinished JSON
 * ({@link ToolArgsCutOffError}) rather than malformed JSON.
 */
function parseCallArgs(
  raw: string,
  toolName: string,
  context: string,
  lastCallAtCap: boolean,
): Result<unknown, ProviderProtocolError> {
  return parseToolArgs(raw, toolName, context).mapErr((parseErr) =>
    lastCallAtCap ? new ToolArgsCutOffError(parseErr) : parseErr,
  );
}

// --- Error mapping ---

/**
 * Content-policy `code` values seen on `OpenAI.BadRequestError` (and Azure's
 * shim that rides on the same SDK). The body of a 400 carries
 * `error.code: "content_policy_violation"` for OpenAI-direct and
 * `error.code: "responsible_ai_policy_violation"` for Azure OpenAI. Azure
 * also documents `error.code: "content_filter"` as the top-level code on a
 * 400 pre-flight block (Scenario 3 in the Azure content-filter docs); the
 * matching `finish_reason: "content_filter"` on the success path is handled
 * separately in `fromOpenAIFinishReason`.
 *
 * Design scope (see design/agent-resilience.md Class C): refusal detection
 * applies to Anthropic-direct + OpenAI-direct. OpenAI-compat shims ride
 * along when they happen to emit the same shape — false positives are
 * acceptable per the design.
 */
const REFUSAL_ERROR_CODES = new Set<string>([
  "content_policy_violation",
  "responsible_ai_policy_violation",
  "content_filter",
]);

/**
 * Returns a `RefusalError` when the SDK error's shape matches a 400-class
 * content-policy refusal; returns `undefined` otherwise so callers can
 * fall through to the original error via `?? err`.
 *
 * Duck-typed on `status` + `code` to avoid binding to the SDK's exact
 * `BadRequestError` class — third-party OpenAI-compat clients sometimes
 * produce structurally-similar errors that don't share the same constructor.
 */
function toRefusalErrorIfMatches(err: unknown): RefusalError | undefined {
  if (!(err instanceof Error)) return undefined;
  if (!("status" in err) || typeof err.status !== "number" || err.status !== 400) return undefined;
  if (!("code" in err) || typeof err.code !== "string" || !REFUSAL_ERROR_CODES.has(err.code)) {
    return undefined;
  }
  return new RefusalError(err.message, err);
}

function fromOpenAIFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      // OpenAI's explicit refusal signal on the success path. Surfaces the
      // Class C "model refusal" subtype (design/agent-resilience.md) for the
      // in-loop classifier. The design scopes this detection to
      // OpenAI-direct + Anthropic-direct, but the same adapter serves
      // OpenAI-compat providers (OpenRouter, Venice, xAI, generic shims) and
      // there's no clean adapter-time way to tell them apart from the base
      // URL alone. Compat providers ride along when they happen to emit an
      // OpenAI-shaped refusal — best-effort, false positives on a compat
      // shim are acceptable per the design.
      return "refusal";
    default:
      return "end_turn";
  }
}
