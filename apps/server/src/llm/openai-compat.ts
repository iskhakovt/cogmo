import type Anthropic from "@anthropic-ai/sdk";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import OpenAI from "openai";
import { logger } from "../logger.js";
import { cacheMarker } from "./anthropic.js";
import type { CacheDialect } from "./cache-dialect.js";
import { ProviderProtocolError, parseToolArgs, ToolArgsCutOffError } from "./errors.js";
import { RefusalError } from "./fallback.js";
import { withFailureLogging } from "./logging-fetch.js";
import { failChatSpan, recordChatUsage, startChatSpan } from "./otel.js";
import type { LlmProvider } from "./provider.js";
import type {
  CacheIntent,
  ChatParams,
  ChatStreamResult,
  ContentBlock,
  CountTokensParams,
  DocumentBlock,
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

/**
 * Upper bound on inlined text-document content per document, in characters.
 * Matches `MAX_READ_LENGTH` in file-tools.ts. Telegram's Bot API delivers
 * files up to 20MB, which would blow past most context windows when
 * inlined verbatim — cap at the same threshold the read_file tool uses.
 */
const MAX_INLINED_DOC_CHARS = 100_000;

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
  /** Which hints a request's cache intent puts on the wire — see {@link CacheDialect}. */
  cacheDialect: CacheDialect;
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

  constructor(name: string, config: OpenAICompatibleConfig) {
    this.name = name;
    this.#cacheDialect = config.cacheDialect;
    this.#client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultHeaders: config.headers,
      fetch: withFailureLogging(config.fetch ?? globalThis.fetch, logger, name),
    });
  }

  async countTokens(params: CountTokensParams): Promise<number> {
    const enc = getEncoder();
    const msgs = buildMessages(params.system, params.messages, undefined);
    let tokens = 0;

    for (const msg of msgs) {
      tokens += 4; // message framing overhead (role, separators)

      if (typeof msg.content === "string") {
        tokens += enc.encode(msg.content).length;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text" && part.text) {
            tokens += enc.encode(part.text).length;
          }
          // Images: ~85 tokens base for low-detail, more for high-detail.
          // Conservative estimate since we don't know the detail setting.
          if (part.type === "image_url") tokens += 85;
        }
      }

      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type !== "function") continue;
          tokens += enc.encode(tc.function.name).length;
          tokens += enc.encode(tc.function.arguments).length;
        }
      }

      if (msg.role === "tool" && typeof msg.content === "string") {
        tokens += enc.encode(msg.content).length;
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

    const hints = cacheHints(this.#cacheDialect, params);
    const span = startChatSpan(this.name, params.model);
    try {
      const createParams: OpenAI.ChatCompletionCreateParamsNonStreaming & CacheHintFields = {
        model: params.model,
        max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: buildMessages(params.system, params.messages, hints.systemMarker),
        ...hints.fields,
      };

      if (params.tools?.length) {
        createParams.tools = params.tools.map(toOpenAITool);
      }

      if (params.temperature !== undefined) {
        createParams.temperature = params.temperature;
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

      const response = await this.#client.chat.completions.create(
        createParams,
        requestOptions(hints),
      );

      const choice = response.choices[0];
      if (!choice) throw new Error("No choices in response");

      const usage: Usage = response.usage
        ? fromOpenAIUsage(response.usage)
        : { inputTokens: 0, outputTokens: 0 };
      const stopReason = fromOpenAIFinishReason(choice.finish_reason);
      recordChatUsage(span, this.name, response.model, usage, stopReason);

      return {
        content: fromOpenAIMessage(choice.message, stopReason),
        stopReason,
        model: response.model,
        usage,
      };
    } catch (err) {
      const mapped = toRefusalErrorIfMatches(err) ?? err;
      failChatSpan(span, mapped);
      throw mapped;
    } finally {
      span.end();
    }
  }

  chatStream(params: ChatParams): ChatStreamResult {
    if (params.responseFormat && params.tools?.length) {
      throw new Error("responseFormat and tools are mutually exclusive");
    }

    let resolveResponse: (v: { stopReason: StopReason; model: string; usage: Usage }) => void;
    let rejectResponse: (err: unknown) => void;
    const response = new Promise<{ stopReason: StopReason; model: string; usage: Usage }>(
      (resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      },
    );

    const client = this.#client;
    const hints = cacheHints(this.#cacheDialect, params);
    const providerName = this.name;
    const span = startChatSpan(providerName, params.model);

    async function* generateEvents(): AsyncIterable<StreamEvent> {
      let completed = false;
      try {
        // Map content-policy 400s to RefusalError at the create-time boundary
        // before they propagate to FallbackLlmProvider. `.catch()` keeps the
        // narrow Stream<...> type from the streaming overload — a try/catch
        // would widen `stream` to the ChatCompletion|Stream union.
        const stream = await client.chat.completions
          .create(
            {
              model: params.model,
              max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
              messages: buildMessages(params.system, params.messages, hints.systemMarker),
              ...hints.fields,
              ...(params.tools?.length && { tools: params.tools.map(toOpenAITool) }),
              ...(params.temperature !== undefined && { temperature: params.temperature }),
              stream: true,
              stream_options: { include_usage: true },
            },
            requestOptions(hints),
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

        // Yield accumulated tool calls as complete tool_start events.
        const calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
        for (const [position, call] of calls.entries()) {
          const input = parseCallArgs(
            call.argumentChunks.join(""),
            call.name,
            "OpenAI-compatible streamed tool_calls arguments",
            finishReason === "max_tokens" && position === calls.length - 1,
          );
          yield { type: "tool_start", id: call.id, name: call.name, input };
        }

        recordChatUsage(span, providerName, model, usage, finishReason);
        completed = true;
        resolveResponse({ stopReason: finishReason, model, usage });
      } catch (err) {
        completed = true;
        failChatSpan(span, err);
        rejectResponse(err);
        throw err;
      } finally {
        if (!completed) {
          const abortErr = new Error("chatStream consumer abandoned the stream");
          failChatSpan(span, abortErr);
          rejectResponse(abortErr);
        }
        span.end();
      }
    }

    return { events: generateEvents(), response };
  }
}

// --- Cache hints ---

/**
 * Request fields a cache intent adds beyond Chat Completions: OpenAI's
 * `prompt_cache_key`, and OpenRouter's `session_id` and top-level
 * `cache_control` (Anthropic's automatic caching, passed through to Claude).
 */
interface CacheHintFields {
  prompt_cache_key?: string;
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
 * breakpoint, both at the intent's TTL. Gemini gets the system marker alone:
 * it takes no TTL, and a tail marker that moves every request makes OpenRouter
 * write a new Gemini cache each time without reading the last one.
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
      return { fields: session, headers: undefined, systemMarker: { type: "ephemeral" } };
    case undefined:
      return { ...NO_HINTS, fields: session };
  }
}

/**
 * The OpenRouter model families that honour `cache_control` markers. A
 * leading `~` marks a family alias (`~anthropic/claude-sonnet-latest`).
 */
function markerFamily(model: string): "anthropic" | "google" | undefined {
  const slug = model.startsWith("~") ? model.slice(1) : model;
  if (slug.startsWith("anthropic/")) return "anthropic";
  if (slug.startsWith("google/")) return "google";
  return undefined;
}

function requestOptions(hints: CacheHints): OpenAI.RequestOptions | undefined {
  return hints.headers && { headers: hints.headers };
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
  const result: OpenAI.ChatCompletionMessageParam[] = [];
  if (system.trim().length > 0) {
    // A marker needs a content block to sit on, so a marked system prompt
    // goes as a one-block array.
    if (systemMarker) {
      const systemPart: OpenAI.ChatCompletionContentPartText & {
        cache_control: Anthropic.CacheControlEphemeral;
      } = { type: "text", text: system, cache_control: systemMarker };
      result.push({ role: "system", content: [systemPart] });
    } else {
      result.push({ role: "system", content: system });
    }
  }

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

      // OpenAI rejects `{role:"assistant", content: null}` with no tool_calls.
      // An assistant turn whose only content was thinking (now stripped, or
      // never visible to OpenAI-compatible endpoints) carries no information
      // the model can use — drop it rather than send a malformed message.
      if (textContent === "" && toolCalls.length === 0) {
        continue;
      }

      result.push({
        role: "assistant",
        content: textContent || null,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      });
    } else {
      // User message — may contain tool_result, text, image, and document blocks
      const toolResults = msg.content.filter((b): b is ToolResultBlock => b.type === "tool_result");
      const textBlocks = msg.content.filter((b): b is TextBlock => b.type === "text");
      const imageBlocks = msg.content.filter((b): b is ImageBlock => b.type === "image");
      const documentBlocks = msg.content.filter((b): b is DocumentBlock => b.type === "document");

      // Tool results become separate "tool" role messages
      for (const tr of toolResults) {
        result.push({
          role: "tool",
          tool_call_id: tr.toolUseId,
          content: tr.content,
        });
      }

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

      // Text + images → multipart content array
      if (allTextBlocks.length > 0 || imageBlocks.length > 0) {
        const parts: OpenAI.ChatCompletionContentPart[] = [];
        for (const tb of allTextBlocks) {
          parts.push({ type: "text", text: tb.text });
        }
        for (const ib of imageBlocks) {
          const url = ib.source === "url" ? ib.data : `data:${ib.mediaType};base64,${ib.data}`;
          parts.push({ type: "image_url", image_url: { url } });
        }
        result.push({
          role: "user",
          content: imageBlocks.length > 0 ? parts : allTextBlocks.map((b) => b.text).join(""),
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

/**
 * Canonical {@link Usage} from a Chat Completions usage block. `prompt_tokens`
 * already includes cached tokens, so it stays the total; reads and writes come
 * from `prompt_tokens_details` (`cached_tokens`, and `cache_write_tokens` on
 * OpenRouter and GPT-5.6+). A count a compatible server omits reads as zero:
 * the loop sums these into an integer column.
 */
function fromOpenAIUsage(usage: OpenAI.CompletionUsage): Usage {
  const details = usage.prompt_tokens_details;
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    ...(details?.cached_tokens != null && { cacheReadTokens: details.cached_tokens }),
    ...(details?.cache_write_tokens != null && {
      cacheCreationTokens: details.cache_write_tokens,
    }),
  };
}

function fromOpenAIMessage(
  message: OpenAI.ChatCompletionMessage,
  stopReason: StopReason,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (message.content) {
    blocks.push({ type: "text", text: message.content });
  }

  const calls = (message.tool_calls ?? []).filter((tc) => tc.type === "function");
  for (const [position, tc] of calls.entries()) {
    blocks.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function.name,
      input: parseCallArgs(
        tc.function.arguments,
        tc.function.name,
        "OpenAI-compatible non-streaming tool_calls arguments",
        stopReason === "max_tokens" && position === calls.length - 1,
      ),
    });
  }

  return blocks;
}

/**
 * Parse one call's arguments. `lastCallAtCap` marks the call the output cap
 * could have cut off — the response's final call when it stopped at
 * `max_tokens` — so a parse failure there is reported as unfinished JSON
 * ({@link ToolArgsCutOffError}) rather than malformed JSON. `parseToolArgs`
 * wraps SyntaxError as ProviderProtocolError so the fallback chain doesn't
 * misclassify it as transient.
 */
function parseCallArgs(
  raw: string,
  toolName: string,
  context: string,
  lastCallAtCap: boolean,
): unknown {
  try {
    return parseToolArgs(raw, toolName, context);
  } catch (err) {
    if (lastCallAtCap && err instanceof ProviderProtocolError) throw new ToolArgsCutOffError(err);
    throw err;
  }
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
