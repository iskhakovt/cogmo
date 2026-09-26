import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { logger } from "../logger.js";
import { expectDefined } from "../test/assertions.js";
import type { CacheDialect } from "./cache-dialect.js";
import { ProviderProtocolError, ToolArgsCutOffError } from "./errors.js";
import { isRetriableProviderError, RefusalError } from "./fallback.js";
import { OpenAICompatibleProvider } from "./openai-compat.js";
import type { CacheIntent, ChatParams, StreamEvent } from "./types.js";

const mockCreate = vi.fn();
// Constructor options each client was built with, newest last.
const clientOptions: Array<{ fetch?: typeof fetch }> = [];
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockCreate } };
      constructor(opts: { fetch?: typeof fetch }) {
        clientOptions.push(opts);
      }
    },
  };
});

// What the provider passes to openai.chat.completions.create. We assert on
// shape (messages array, tools array, etc.) — fields are kept loose because
// the upstream type surface is large and not worth re-enumerating here.
const ChatCreateArgsSchema = z
  .object({
    messages: z.array(
      z
        .object({
          role: z.string(),
          content: z.unknown().optional(),
          tool_call_id: z.string().optional(),
          tool_calls: z.array(z.unknown()).optional(),
        })
        .passthrough(),
    ),
    tools: z.array(z.unknown()).optional(),
    model: z.string().optional(),
  })
  .passthrough();

type ChatCreateArgs = z.infer<typeof ChatCreateArgsSchema>;
type ChatMessage = ChatCreateArgs["messages"][number];

function firstCreateArgs(): ChatCreateArgs {
  const call = mockCreate.mock.calls[0];
  if (!call) throw new Error("expected openai.chat.completions.create to have been called");
  return ChatCreateArgsSchema.parse(call[0]);
}

function getMessage(args: ChatCreateArgs, index: number): ChatMessage {
  const msg = args.messages[index];
  if (!msg) throw new Error(`expected messages[${index}] to be present`);
  return msg;
}

function getTool(args: ChatCreateArgs, index: number): unknown {
  if (!args.tools) throw new Error("expected tools array on create args");
  const tool = args.tools[index];
  if (tool === undefined) throw new Error(`expected tools[${index}] to be present`);
  return tool;
}

function createProvider(cacheDialect: CacheDialect = "none"): OpenAICompatibleProvider {
  mockCreate.mockReset();
  return new OpenAICompatibleProvider("test", {
    apiKey: "test-key",
    baseURL: "http://test",
    cacheDialect,
  });
}

function mockStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length) return { value: chunks[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

describe("OpenAICompatibleProvider", () => {
  describe("chat", () => {
    it("maps a simple text response", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "Hello!", tool_calls: null }, finish_reason: "stop" }],
        model: "gpt-5-nano",
        usage: { prompt_tokens: 15, completion_tokens: 8 },
      });

      const result = await provider.chat({
        model: "gpt-5-nano",
        system: "Be helpful",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content).toEqual([{ type: "text", text: "Hello!" }]);
      expect(result.stopReason).toBe("end_turn");
      expect(result.model).toBe("gpt-5-nano");
      expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 8 });
    });

    it("maps tool_calls response", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "web_search", arguments: '{"query":"weather"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        model: "gpt-5-nano",
        usage: { prompt_tokens: 20, completion_tokens: 12 },
      });

      const result = await provider.chat({
        model: "gpt-5-nano",
        system: "sys",
        messages: [{ role: "user", content: "search" }],
      });

      expect(result.stopReason).toBe("tool_use");
      expect(result.content).toEqual([
        { type: "tool_use", id: "call_1", name: "web_search", input: { query: "weather" } },
      ]);
    });

    it("maps tool_calls response with empty arguments to input: {}", async () => {
      // Some OpenAI-compatible providers (OpenRouter, xAI-via-OpenRouter,
      // Together) return arguments: "" for zero-arg tools instead of
      // "{}". A bare JSON.parse would throw SyntaxError, which the
      // fallback chain would misclassify as a transient network error.
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_empty",
                  type: "function",
                  function: { name: "now", arguments: "" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        model: "m",
        usage: { prompt_tokens: 8, completion_tokens: 2 },
      });
      const result = await provider.chat({
        model: "m",
        system: "sys",
        messages: [{ role: "user", content: "time" }],
      });
      expect(result.stopReason).toBe("tool_use");
      expect(result.content).toEqual([
        { type: "tool_use", id: "call_empty", name: "now", input: {} },
      ]);
    });

    it("sends system as first message", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        model: "m",
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      });

      await provider.chat({
        model: "m",
        system: "Be concise",
        messages: [{ role: "user", content: "hi" }],
      });

      const args = firstCreateArgs();
      expect(getMessage(args, 0)).toEqual({ role: "system", content: "Be concise" });
      expect(getMessage(args, 1)).toEqual({ role: "user", content: "hi" });
    });

    it("omits the system message when the system prompt is empty (non-caching)", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        model: "m",
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });

      await provider.chat({ model: "m", system: "", messages: [{ role: "user", content: "hi" }] });

      const args = firstCreateArgs();
      expect(args.messages.some((m) => m.role === "system")).toBe(false);
      expect(getMessage(args, 0).role).toBe("user");
    });

    it("omits the system message when the system prompt is empty (cache markers)", async () => {
      // A null-persona sub-agent routed via OpenRouter → Anthropic: an empty
      // system text block 400s downstream, so it must be dropped, not sent.
      const provider = createProvider("openrouter");
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        model: "m",
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });

      await provider.chat({
        model: "anthropic/claude-sonnet-5",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        cache: { key: "conv-1", retention: "long" },
      });

      const args = firstCreateArgs();
      expect(args.messages.some((m) => m.role === "system")).toBe(false);
    });

    it("translates tool_result blocks to tool role messages", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        model: "m",
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      });

      await provider.chat({
        model: "m",
        system: "sys",
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_1", name: "test", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", toolUseId: "call_1", content: "result data" }],
          },
        ],
      });

      const args = firstCreateArgs();
      // System + assistant + tool + (no text user msg)
      expect(args.messages).toHaveLength(3);
      expect(getMessage(args, 2)).toEqual({
        role: "tool",
        tool_call_id: "call_1",
        content: "result data",
      });
    });

    it("passes tools in OpenAI function format", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        model: "m",
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      });

      await provider.chat({
        model: "m",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "my_tool",
            description: "does things",
            parameters: { type: "object", properties: { x: { type: "string" } } },
          },
        ],
      });

      const args = firstCreateArgs();
      expect(getTool(args, 0)).toEqual({
        type: "function",
        function: {
          name: "my_tool",
          description: "does things",
          parameters: { type: "object", properties: { x: { type: "string" } } },
        },
      });
    });
  });

  describe("chatStream", () => {
    it("yields text_delta events", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            model: "gpt-5-nano",
            choices: [{ delta: { content: "Hello" }, finish_reason: null }],
            usage: null,
          },
          {
            model: "gpt-5-nano",
            choices: [{ delta: { content: " world" }, finish_reason: null }],
            usage: null,
          },
          {
            model: "gpt-5-nano",
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          },
        ]),
      );

      const { events, response } = provider.chatStream({
        model: "gpt-5-nano",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      });

      const collected: StreamEvent[] = [];
      for await (const event of events) collected.push(event);

      expect(collected).toEqual([
        { type: "text_delta", text: "Hello" },
        { type: "text_delta", text: " world" },
      ]);

      const meta = await response;
      expect(meta.stopReason).toBe("end_turn");
      expect(meta.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("yields tool_start with empty input when the stream emits no arguments delta (zero-arg tool)", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            model: "m",
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: "call_zero", function: { name: "now" } }],
                },
                finish_reason: null,
              },
            ],
            usage: null,
          },
          {
            model: "m",
            choices: [{ delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 8, completion_tokens: 2 },
          },
        ]),
      );
      const { events, response } = provider.chatStream({
        model: "m",
        system: "sys",
        messages: [{ role: "user", content: "time" }],
      });
      const collected: StreamEvent[] = [];
      for await (const event of events) collected.push(event);
      expect(collected).toEqual([{ type: "tool_start", id: "call_zero", name: "now", input: {} }]);
      const meta = await response;
      expect(meta.stopReason).toBe("tool_use");
    });

    it("accumulates tool calls and yields tool_start after stream ends", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            model: "m",
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: "search", arguments: '{"q":' } },
                  ],
                },
                finish_reason: null,
              },
            ],
            usage: null,
          },
          {
            model: "m",
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '"test"}' } }],
                },
                finish_reason: null,
              },
            ],
            usage: null,
          },
          {
            model: "m",
            choices: [{ delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 10, completion_tokens: 8 },
          },
        ]),
      );

      const { events, response } = provider.chatStream({
        model: "m",
        system: "sys",
        messages: [{ role: "user", content: "search" }],
      });

      const collected: StreamEvent[] = [];
      for await (const event of events) collected.push(event);

      expect(collected).toEqual([
        { type: "tool_start", id: "call_1", name: "search", input: { q: "test" } },
      ]);

      const meta = await response;
      expect(meta.stopReason).toBe("tool_use");
    });

    it("passes stream: true to API", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            model: "m",
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 0 },
          },
        ]),
      );

      const { events } = provider.chatStream({
        model: "m",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      });
      for await (const _ of events) {
        /* drain */
      }

      const args = firstCreateArgs();
      expect(args.stream).toBe(true);
    });

    // OpenAI-compatible upstreams surface stream failures one of two ways:
    // an `APIError`-shaped object before the first chunk (5xx with body) or
    // an `APIConnectionError`-shaped throw while iterating chunks (no
    // `.status`). Both cases must (a) reject the iterator, (b) reject the
    // `response` promise, and (c) propagate the original shape so
    // `isRetriableProviderError` (which keys off `.status` presence) makes
    // the right call upstream of `FallbackLlmProvider`.
    it("propagates a pre-stream 502 with a numeric status on both events and response", async () => {
      const provider = createProvider();
      const upstream = Object.assign(new Error("Bad gateway"), {
        name: "APIError",
        status: 502,
      });
      mockCreate.mockRejectedValueOnce(upstream);

      const { events, response } = provider.chatStream({
        model: "anthropic/claude-sonnet-4",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      });

      const iter = events[Symbol.asyncIterator]();
      await expect(iter.next()).rejects.toMatchObject({ status: 502 });
      await expect(response).rejects.toMatchObject({ status: 502 });
    });

    it("propagates a mid-stream connection drop on both events and response", async () => {
      const provider = createProvider();
      const drop = Object.assign(new Error("connection reset"), {
        name: "APIConnectionError",
      });

      // Yield one delta, then explode — mirrors the chunked-SSE pattern
      // where HTTP 200 starts the stream but the connection aborts
      // mid-flight (network hiccup or upstream gateway closing the socket).
      mockCreate.mockResolvedValueOnce({
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next(): Promise<IteratorResult<unknown>> {
              if (i++ === 0) {
                return {
                  value: {
                    model: "m",
                    choices: [{ delta: { content: "partial" }, finish_reason: null }],
                    usage: null,
                  },
                  done: false,
                };
              }
              throw drop;
            },
          };
        },
      });

      const { events, response } = provider.chatStream({
        model: "m",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      });

      const iter = events[Symbol.asyncIterator]();
      const first = await iter.next();
      expect(first.value).toEqual({ type: "text_delta", text: "partial" });
      await expect(iter.next()).rejects.toBe(drop);
      await expect(response).rejects.toBe(drop);
    });

    it("repairs trailing-comma JSON in tool args via jsonrepair before declaring failure (OpenAI-compat stream)", async () => {
      const provider = createProvider();
      // Reconstructed buffer: `{"query":"weather",}` — valid after
      // jsonrepair drops the trailing comma.
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            model: "m",
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "search", arguments: '{"query":"weather",' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
            usage: null,
          },
          {
            model: "m",
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] },
                finish_reason: null,
              },
            ],
            usage: null,
          },
          {
            model: "m",
            choices: [{ delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 10, completion_tokens: 8 },
          },
        ]),
      );

      const { events, response } = provider.chatStream({
        model: "m",
        system: "sys",
        messages: [{ role: "user", content: "search" }],
      });

      const collected: StreamEvent[] = [];
      for await (const event of events) collected.push(event);

      expect(collected).toEqual([
        { type: "tool_start", id: "call_1", name: "search", input: { query: "weather" } },
      ]);
      await expect(response).resolves.toMatchObject({ stopReason: "tool_use" });
    });

    it("throws ProviderProtocolError on tool-arg JSON unrepairable by jsonrepair (OpenAI-compat stream)", async () => {
      const provider = createProvider();
      // `}}}]]]` — closers-only with no payload. There is nothing for any
      // future jsonrepair heuristic to wrap, so this stays unrepairable
      // across library upgrades; a more typo-shaped input could silently
      // start passing if jsonrepair broadens its recovery surface.
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            model: "m",
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: "search", arguments: "}}}]]]" } },
                  ],
                },
                finish_reason: null,
              },
            ],
            usage: null,
          },
          {
            model: "m",
            choices: [{ delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 10, completion_tokens: 8 },
          },
        ]),
      );

      const { events, response } = provider.chatStream({
        model: "m",
        system: "sys",
        messages: [{ role: "user", content: "search" }],
      });

      const collect = async (): Promise<StreamEvent[]> => {
        const out: StreamEvent[] = [];
        for await (const event of events) out.push(event);
        return out;
      };

      await expect(collect()).rejects.toBeInstanceOf(ProviderProtocolError);
      await expect(response).rejects.toBeInstanceOf(ProviderProtocolError);
    });

    // `length` means the cap cut the response off, so the unparseable final
    // call is unfinished JSON. An earlier call, or any other finish reason,
    // is malformed JSON.
    it.each([
      {
        label: "the last call of a length-capped stream",
        failing: 1,
        finish: "length",
        cutOff: true,
      },
      {
        label: "an earlier call of a length-capped stream",
        failing: 0,
        finish: "length",
        cutOff: false,
      },
      {
        label: "the last call of a tool_calls stream",
        failing: 1,
        finish: "tool_calls",
        cutOff: false,
      },
    ])(
      "reports unparseable args of $label as cut off: $cutOff",
      async ({ failing, finish, cutOff }) => {
        const provider = createProvider();
        const args = (index: number) => (index === failing ? "}}}]]]" : '{"q":"x"}');
        mockCreate.mockResolvedValueOnce(
          mockStream([
            {
              model: "m",
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: "call_1", function: { name: "search", arguments: args(0) } },
                      { index: 1, id: "call_2", function: { name: "write", arguments: args(1) } },
                    ],
                  },
                  finish_reason: null,
                },
              ],
              usage: null,
            },
            {
              model: "m",
              choices: [{ delta: {}, finish_reason: finish }],
              usage: { prompt_tokens: 10, completion_tokens: 8 },
            },
          ]),
        );

        const { events, response } = provider.chatStream({
          model: "m",
          system: "sys",
          messages: [{ role: "user", content: "go" }],
        });
        const drained = (async () => {
          for await (const _event of events) {
            // drain
          }
        })();

        const error = await drained.then(
          () => undefined,
          (err: unknown) => err,
        );
        expect(error).toBeInstanceOf(ProviderProtocolError);
        expect(error instanceof ToolArgsCutOffError).toBe(cutOff);
        await expect(response).rejects.toBe(error);
      },
    );

    it("reports a length-capped non-streaming response's unparseable final call as cut off", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        model: "m",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "write", arguments: "}}}]]]" },
                },
              ],
            },
            finish_reason: "length",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      });

      await expect(
        provider.chat({ model: "m", system: "sys", messages: [{ role: "user", content: "go" }] }),
      ).rejects.toBeInstanceOf(ToolArgsCutOffError);
    });
  });

  // Refusal decoding: see design/agent-resilience.md Class C "model refusal".
  // Success path: finish_reason "content_filter" → stopReason "refusal".
  // Error path: 400 BadRequestError with a content-policy code → RefusalError,
  // which `isRetriableProviderError` reports as non-retriable so the provider
  // chain propagates it untouched (silent re-routing across providers on a
  // policy refusal is the wrong shape).
  describe("refusal decoding", () => {
    it("maps finish_reason 'content_filter' to stopReason 'refusal' (non-stream)", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { content: "I cannot help with that.", tool_calls: null },
            finish_reason: "content_filter",
          },
        ],
        model: "gpt-5-nano",
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      });

      const result = await provider.chat({
        model: "gpt-5-nano",
        system: "sys",
        messages: [{ role: "user", content: "disallowed request" }],
      });

      expect(result.stopReason).toBe("refusal");
    });

    it("maps finish_reason 'content_filter' to stopReason 'refusal' (stream)", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            model: "gpt-5-nano",
            choices: [{ delta: { content: "I cannot help" }, finish_reason: null }],
            usage: null,
          },
          {
            model: "gpt-5-nano",
            choices: [{ delta: {}, finish_reason: "content_filter" }],
            usage: { prompt_tokens: 20, completion_tokens: 8 },
          },
        ]),
      );

      const { events, response } = provider.chatStream({
        model: "gpt-5-nano",
        system: "sys",
        messages: [{ role: "user", content: "disallowed request" }],
      });
      for await (const _ of events) {
        /* drain */
      }

      const meta = await response;
      expect(meta.stopReason).toBe("refusal");
    });

    it("wraps a 400 content_policy_violation BadRequestError as RefusalError", async () => {
      const provider = createProvider();
      // Mirror OpenAI's BadRequestError shape — `.status` 400, `.code` set by
      // the SDK from the response body's `error.code`. Duck-typed; the
      // adapter doesn't bind to the SDK's concrete class.
      const upstream = Object.assign(
        new Error("Your request was rejected as a result of our safety system."),
        {
          name: "BadRequestError",
          status: 400,
          code: "content_policy_violation",
        },
      );
      mockCreate.mockRejectedValueOnce(upstream);

      await expect(
        provider.chat({
          model: "gpt-5-nano",
          system: "sys",
          messages: [{ role: "user", content: "disallowed request" }],
        }),
      ).rejects.toBeInstanceOf(RefusalError);
    });

    it("wraps Azure responsible_ai_policy_violation as RefusalError", async () => {
      // Azure OpenAI rides on the same SDK shape but uses its own code.
      const provider = createProvider();
      const upstream = Object.assign(new Error("Blocked by content management policy"), {
        name: "BadRequestError",
        status: 400,
        code: "responsible_ai_policy_violation",
      });
      mockCreate.mockRejectedValueOnce(upstream);

      await expect(
        provider.chat({
          model: "gpt-5-nano",
          system: "sys",
          messages: [{ role: "user", content: "disallowed request" }],
        }),
      ).rejects.toBeInstanceOf(RefusalError);
    });

    it("wraps Azure content_filter (top-level error.code) as RefusalError", async () => {
      // Per the Azure OpenAI content-filter docs (Scenario 3, "Inappropriate
      // input prompt"), a 400 pre-flight block surfaces with
      // `error.code: "content_filter"` at the top level — distinct from the
      // success-path `finish_reason: "content_filter"` on choices.
      const provider = createProvider();
      const upstream = Object.assign(new Error("The response was filtered"), {
        name: "BadRequestError",
        status: 400,
        code: "content_filter",
      });
      mockCreate.mockRejectedValueOnce(upstream);

      await expect(
        provider.chat({
          model: "gpt-5-nano",
          system: "sys",
          messages: [{ role: "user", content: "disallowed request" }],
        }),
      ).rejects.toBeInstanceOf(RefusalError);
    });

    it("does NOT wrap unrelated 400 errors (e.g. invalid_request_error)", async () => {
      const provider = createProvider();
      const upstream = Object.assign(new Error("Invalid 'messages[0].role'"), {
        name: "BadRequestError",
        status: 400,
        code: "invalid_request_error",
      });
      mockCreate.mockRejectedValueOnce(upstream);

      // The original error propagates with its 400 status intact — no wrap.
      const caught = await provider
        .chat({
          model: "gpt-5-nano",
          system: "sys",
          messages: [{ role: "user", content: "hi" }],
        })
        .catch((e) => e);

      expect(caught).toBe(upstream);
      expect(caught).not.toBeInstanceOf(RefusalError);
    });

    it("wraps a content_policy_violation thrown pre-stream as RefusalError", async () => {
      const provider = createProvider();
      const upstream = Object.assign(
        new Error("Your request was rejected as a result of our safety system."),
        {
          name: "BadRequestError",
          status: 400,
          code: "content_policy_violation",
        },
      );
      mockCreate.mockRejectedValueOnce(upstream);

      const { events, response } = provider.chatStream({
        model: "gpt-5-nano",
        system: "sys",
        messages: [{ role: "user", content: "disallowed request" }],
      });

      const iter = events[Symbol.asyncIterator]();
      await expect(iter.next()).rejects.toBeInstanceOf(RefusalError);
      await expect(response).rejects.toBeInstanceOf(RefusalError);
    });

    it("RefusalError is non-retriable", () => {
      // Contract: FallbackLlmProvider must propagate refusals without trying
      // the next candidate. The classification predicate stays binary; the
      // RefusalError instance check rides in front of the status-based rules.
      expect(isRetriableProviderError(new RefusalError("refused"))).toBe(false);
    });
  });

  // `prompt_tokens` already includes cached tokens, so it stays the total and
  // the cache counts are read alongside it as subsets.
  describe("usage", () => {
    it("reads cache reads and writes from prompt_tokens_details on a non-streaming response", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        model: "openai/gpt-5.6",
        usage: {
          prompt_tokens: 4711,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 3840, cache_write_tokens: 800 },
        },
      });

      const result = await provider.chat({
        model: "openai/gpt-5.6",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result.usage).toEqual({
        inputTokens: 4711,
        outputTokens: 20,
        cacheReadTokens: 3840,
        cacheCreationTokens: 800,
      });
    });

    it("reports cache reads without writes when the server reports only cached_tokens", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        model: "gpt-5.4-nano",
        usage: {
          prompt_tokens: 4711,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 3840 },
        },
      });

      const result = await provider.chat({
        model: "gpt-5.4-nano",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result.usage).toEqual({ inputTokens: 4711, outputTokens: 20, cacheReadTokens: 3840 });
    });

    it("reads cache reads and writes from the final chunk's usage on a stream", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            model: "anthropic/claude-sonnet-5",
            choices: [{ delta: { content: "ok" }, finish_reason: null }],
            usage: null,
          },
          {
            model: "anthropic/claude-sonnet-5",
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 7500,
              completion_tokens: 12,
              prompt_tokens_details: { cached_tokens: 7360, cache_write_tokens: 68 },
            },
          },
        ]),
      );

      const { events, response } = provider.chatStream({
        model: "anthropic/claude-sonnet-5",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      });
      for await (const _ of events) {
        // drain
      }

      expect((await response).usage).toEqual({
        inputTokens: 7500,
        outputTokens: 12,
        cacheReadTokens: 7360,
        cacheCreationTokens: 68,
      });
    });

    // The SDK types both counts as required, but a compatible server can send
    // a usage block without them. A missing count must read as zero: the
    // loop sums usage across iterations and persists the input as an
    // integer, where `undefined` would become NaN.
    it("reads counts a server leaves out of the usage block as zero on a non-streaming response", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        model: "local-model",
        usage: { total_tokens: 12 },
      });

      const result = await provider.chat({
        model: "local-model",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it("reads counts a server leaves out of the usage block as zero on a stream", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            model: "local-model",
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
            usage: { completion_tokens: 3 },
          },
        ]),
      );

      const { events, response } = provider.chatStream({
        model: "local-model",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      });
      for await (const _ of events) {
        // drain
      }

      expect((await response).usage).toEqual({ inputTokens: 0, outputTokens: 3 });
    });
  });

  describe("injected fetch", () => {
    it("sends requests through the injected fetch, wrapped in the failure logger", async () => {
      const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
        return new Response('{"error":{}}', { status: 500 });
      });
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        new OpenAICompatibleProvider("openrouter", {
          apiKey: "test-key",
          baseURL: "http://test",
          cacheDialect: "openrouter",
          fetch: inner,
        });
        const sdkFetch = expectDefined(clientOptions.at(-1)?.fetch, "fetch handed to the SDK");

        const res = await sdkFetch("http://test/chat/completions", { method: "POST", body: "{}" });

        expect(res.status).toBe(500);
        expect(inner).toHaveBeenCalledOnce();
        expect(errorSpy).toHaveBeenCalledWith(
          expect.objectContaining({ providerName: "openrouter", status: 500 }),
          "llm request failed",
        );
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe("cache dialects", () => {
    const INTENT: CacheIntent = { key: "conv-1", retention: "long" };

    const TRANSCRIPT: ChatParams["messages"] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "search", input: { q: "x" } }],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "call_1", content: "found" }] },
    ];

    function okCompletion(): unknown {
      return {
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        model: "m",
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      };
    }

    const RequestOptionsSchema = z
      .object({ headers: z.record(z.string(), z.string()).optional() })
      .optional();

    interface Sent {
      body: Record<string, unknown>;
      /** Request options handed to `create` — per-request headers live here. */
      options: z.infer<typeof RequestOptionsSchema>;
    }

    function sent(): Sent {
      const call = expectDefined(mockCreate.mock.calls[0], "create call");
      return {
        body: z.record(z.string(), z.unknown()).parse(call[0]),
        options: RequestOptionsSchema.parse(call[1]),
      };
    }

    async function chatWith(
      dialect: CacheDialect,
      params: Partial<ChatParams> & Pick<ChatParams, "model">,
    ): Promise<Sent> {
      const provider = createProvider(dialect);
      mockCreate.mockResolvedValueOnce(okCompletion());
      await provider.chat({ system: "sys", messages: TRANSCRIPT, ...params });
      return sent();
    }

    function systemContent(body: Record<string, unknown>): unknown {
      return getMessage(ChatCreateArgsSchema.parse(body), 0).content;
    }

    /** Every `cache_control` value in a request body, the top-level field included. */
    function breakpoints(value: unknown): unknown[] {
      if (Array.isArray(value)) return value.flatMap(breakpoints);
      if (typeof value !== "object" || value === null) return [];
      return Object.entries(value).flatMap(([key, inner]) =>
        key === "cache_control" ? [inner] : breakpoints(inner),
      );
    }

    /** The top-level fields a dialect may add; each appears only when the dialect sends it. */
    const HINT_FIELDS = [
      "session_id",
      "prompt_cache_key",
      "prompt_cache_retention",
      "cache_control",
    ];

    function hintFields(body: Record<string, unknown>): string[] {
      return HINT_FIELDS.filter((field) => field in body);
    }

    describe("openrouter", () => {
      it.each([
        ["short", "5m"],
        ["long", "1h"],
      ] as const)(
        "on an anthropic/ model, a %s intent marks the system prompt and the tail at %s and pins the session",
        async (retention, ttl) => {
          const { body, options } = await chatWith("openrouter", {
            model: "anthropic/claude-sonnet-5",
            cache: { key: "conv-1", retention },
          });
          const marker = { type: "ephemeral", ttl };

          expect(body.session_id).toBe("conv-1");
          // Top-level automatic caching places the transcript breakpoint.
          expect(body.cache_control).toEqual(marker);
          expect(systemContent(body)).toEqual([
            { type: "text", text: "sys", cache_control: marker },
          ]);
          // Two breakpoints at one TTL: a longer TTL after a shorter one is a 400.
          expect(breakpoints(body)).toEqual([marker, marker]);
          expect(hintFields(body)).toEqual(["session_id", "cache_control"]);
          expect(options?.headers).toBeUndefined();
        },
      );

      it("treats a ~anthropic/ alias as an anthropic/ model", async () => {
        const { body } = await chatWith("openrouter", {
          model: "~anthropic/claude-sonnet-latest",
          cache: INTENT,
        });

        expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
      });

      it("on an anthropic/ model without an intent, marks only the system prompt, at the default TTL", async () => {
        const { body } = await chatWith("openrouter", { model: "anthropic/claude-sonnet-5" });

        expect(breakpoints(body)).toEqual([{ type: "ephemeral" }]);
        expect(systemContent(body)).toEqual([
          { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
        ]);
        expect(hintFields(body)).toEqual([]);
      });

      it("on a google/ model, marks only the system prompt whatever the intent, and pins the session", async () => {
        const withIntent = await chatWith("openrouter", {
          model: "google/gemini-2.5-flash",
          cache: INTENT,
        });
        const withoutIntent = await chatWith("openrouter", { model: "google/gemini-2.5-flash" });

        // Gemini takes no TTL, and a tail marker that moves every request
        // writes a new cache each time without reading the last one.
        expect(breakpoints(withIntent.body)).toEqual([{ type: "ephemeral" }]);
        expect(systemContent(withIntent.body)).toEqual([
          { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
        ]);
        expect(hintFields(withIntent.body)).toEqual(["session_id"]);
        expect(withIntent.body.session_id).toBe("conv-1");

        expect(breakpoints(withoutIntent.body)).toEqual([{ type: "ephemeral" }]);
        expect(hintFields(withoutIntent.body)).toEqual([]);
      });

      it("on any other model, pins the session and sends no markers", async () => {
        const { body, options } = await chatWith("openrouter", {
          model: "x-ai/grok-4.3",
          cache: INTENT,
        });

        expect(body.session_id).toBe("conv-1");
        expect(breakpoints(body)).toEqual([]);
        expect(systemContent(body)).toBe("sys");
        expect(hintFields(body)).toEqual(["session_id"]);
        expect(options?.headers).toBeUndefined();
      });

      it("sends nothing to any other model without an intent", async () => {
        const { body } = await chatWith("openrouter", { model: "x-ai/grok-4.3" });

        expect(breakpoints(body)).toEqual([]);
        expect(hintFields(body)).toEqual([]);
      });
    });

    describe("openai", () => {
      it("sends the intent's key as prompt_cache_key, and no retention", async () => {
        const { body, options } = await chatWith("openai", {
          model: "gpt-5.4-nano",
          cache: INTENT,
        });

        expect(body.prompt_cache_key).toBe("conv-1");
        expect(hintFields(body)).toEqual(["prompt_cache_key"]);
        expect(breakpoints(body)).toEqual([]);
        expect(options?.headers).toBeUndefined();
      });

      it("sends nothing without an intent", async () => {
        const { body } = await chatWith("openai", { model: "gpt-5.4-nano" });

        expect(hintFields(body)).toEqual([]);
      });
    });

    describe("xai", () => {
      it("sends the intent's key as the x-grok-conv-id header, and nothing in the body", async () => {
        const { body, options } = await chatWith("xai", { model: "grok-4.3", cache: INTENT });

        expect(options?.headers).toEqual({ "x-grok-conv-id": "conv-1" });
        expect(hintFields(body)).toEqual([]);
        expect(breakpoints(body)).toEqual([]);
      });

      it("sends no header without an intent", async () => {
        const { options } = await chatWith("xai", { model: "grok-4.3" });

        expect(options?.headers).toBeUndefined();
      });
    });

    it("none sends nothing for an intent", async () => {
      const { body, options } = await chatWith("none", {
        model: "anthropic/claude-sonnet-5",
        cache: INTENT,
      });

      expect(hintFields(body)).toEqual([]);
      expect(breakpoints(body)).toEqual([]);
      expect(systemContent(body)).toBe("sys");
      expect(options?.headers).toBeUndefined();
    });

    it.each(["openrouter", "openai", "xai"] as const)(
      "%s takes no transcript caching on the responseFormat path",
      async (dialect) => {
        const { body, options } = await chatWith(dialect, {
          model: "anthropic/claude-sonnet-5",
          messages: [{ role: "user", content: "hi" }],
          responseFormat: { type: "json_schema", name: "extract", schema: { type: "object" } },
          cache: INTENT,
        });

        // A structured-output call is one-shot, so it maps as if it had no
        // intent: only the default system marker OpenRouter sends Claude.
        expect(hintFields(body)).toEqual([]);
        expect(breakpoints(body)).toEqual(dialect === "openrouter" ? [{ type: "ephemeral" }] : []);
        expect(options?.headers).toBeUndefined();
      },
    );

    it.each([
      ["openrouter", "anthropic/claude-sonnet-5"],
      ["xai", "grok-4.3"],
    ] as const)(
      "maps the intent the same way on the streaming path (%s)",
      async (dialect, model) => {
        const provider = createProvider(dialect);
        mockCreate.mockResolvedValueOnce(
          mockStream([
            {
              model,
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 5, completion_tokens: 0 },
            },
          ]),
        );

        const { events } = provider.chatStream({
          model,
          system: "sys",
          messages: TRANSCRIPT,
          cache: INTENT,
        });
        for await (const _ of events) {
          /* drain */
        }

        const { body, options } = sent();
        expect(body.stream).toBe(true);
        if (dialect === "openrouter") {
          expect(body.session_id).toBe("conv-1");
          expect(breakpoints(body)).toEqual([
            { type: "ephemeral", ttl: "1h" },
            { type: "ephemeral", ttl: "1h" },
          ]);
        } else {
          expect(options?.headers).toEqual({ "x-grok-conv-id": "conv-1" });
        }
      },
    );

    it("takes no cache intent on countTokens, and counts the same if handed one", async () => {
      const provider = createProvider("openrouter");
      const params = {
        model: "anthropic/claude-sonnet-5",
        system: "sys",
        messages: TRANSCRIPT,
      };

      const plain = await provider.countTokens(params);
      const handedIntent = await provider.countTokens({
        ...params,
        // @ts-expect-error — nothing re-sends a count's transcript, so the type has no intent
        cache: INTENT,
      });

      expect(handedIntent).toBe(plain);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe("countTokens", () => {
    it("returns a positive token count for simple messages", async () => {
      const provider = createProvider();
      const count = await provider.countTokens({
        model: "gpt-4o",
        system: "You are helpful.",
        messages: [{ role: "user", content: "Hello, world!" }],
      });

      expect(count).toBeGreaterThan(0);
    });

    it("increases count when tools are provided", async () => {
      const provider = createProvider();
      const base = await provider.countTokens({
        model: "gpt-4o",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      });

      const withTools = await provider.countTokens({
        model: "gpt-4o",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "web_search",
            description: "Search the web for information",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
      });

      expect(withTools).toBeGreaterThan(base);
    });

    it("counts tool_result content in messages", async () => {
      const provider = createProvider();
      const withShortResult = await provider.countTokens({
        model: "gpt-4o",
        system: "sys",
        messages: [
          { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "short" }] },
        ],
      });

      const withLongResult = await createProvider().countTokens({
        model: "gpt-4o",
        system: "sys",
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", toolUseId: "t1", content: "x".repeat(500) }],
          },
        ],
      });

      expect(withLongResult).toBeGreaterThan(withShortResult);
    });
  });

  describe("responseFormat", () => {
    it("passes native json_schema response_format", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: '{"name":"Alice","age":30}' }, finish_reason: "stop" }],
        model: "gpt-4o",
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      });

      const result = await provider.chat({
        model: "gpt-4o",
        system: "Extract data",
        messages: [{ role: "user", content: "Alice is 30" }],
        responseFormat: {
          type: "json_schema",
          name: "extract_data",
          schema: {
            type: "object",
            properties: { name: { type: "string" }, age: { type: "number" } },
            required: ["name", "age"],
          },
        },
      });

      expect(result.content).toEqual([{ type: "text", text: '{"name":"Alice","age":30}' }]);

      const args = firstCreateArgs();
      expect(args.response_format).toEqual({
        type: "json_schema",
        json_schema: {
          name: "extract_data",
          schema: {
            type: "object",
            properties: { name: { type: "string" }, age: { type: "number" } },
            required: ["name", "age"],
          },
          strict: true,
        },
      });
      // No tools when using responseFormat
      expect(args.tools).toBeUndefined();
    });

    it("throws when both responseFormat and tools are provided", async () => {
      const provider = createProvider();

      await expect(
        provider.chat({
          model: "gpt-4o",
          system: "sys",
          messages: [{ role: "user", content: "hi" }],
          responseFormat: {
            type: "json_schema",
            name: "result",
            schema: { type: "object" },
          },
          tools: [{ name: "search", description: "search", parameters: { type: "object" } }],
        }),
      ).rejects.toThrow("mutually exclusive");
    });
  });

  describe("thinking blocks in messages", () => {
    it("skips thinking blocks when building messages", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        model: "m",
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      });

      await provider.chat({
        model: "m",
        system: "sys",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "internal reasoning", signature: "sig" },
              { type: "text", text: "visible answer" },
            ],
          },
          { role: "user", content: "follow up" },
        ],
      });

      const args = firstCreateArgs();
      const assistantMsg = getMessage(args, 1); // [0] is system
      // Text extracted, thinking blocks filtered out
      expect(assistantMsg.content).toBe("visible answer");
      // No thinking content leaked into the message
      expect(JSON.stringify(assistantMsg)).not.toContain("internal reasoning");
    });

    it("drops an assistant turn whose only content is thinking blocks", async () => {
      // Reproduces the prod failure where `clearOldThinking` (or cross-provider
      // history reuse) leaves an older assistant turn with no text/tool_use,
      // only zeroed thinking. Sending `{role:"assistant", content: null}`
      // without `tool_calls` makes OpenAI-compatible backends 400 with
      // messages like "list object has no element 0".
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        model: "m",
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      });

      await provider.chat({
        model: "m",
        system: "sys",
        messages: [
          { role: "user", content: "first turn" },
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "", signature: "sig" }],
          },
          { role: "user", content: "follow up" },
        ],
      });

      const args = firstCreateArgs();
      // [0] system, [1] user "first turn", [2] user "follow up" — the
      // thinking-only assistant turn was dropped, not sent as `content: null`.
      expect(args.messages).toHaveLength(3);
      expect(getMessage(args, 0).role).toBe("system");
      expect(getMessage(args, 1)).toMatchObject({ role: "user", content: "first turn" });
      expect(getMessage(args, 2)).toMatchObject({ role: "user", content: "follow up" });
    });
  });

  describe("document blocks in messages", () => {
    function setup() {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        model: "m",
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      });
      return provider;
    }

    it("inlines a text/* base64 document into a text part", async () => {
      const provider = setup();
      await provider.chat({
        model: "m",
        system: "sys",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarize this:" },
              {
                type: "document",
                source: "base64",
                // base64 of "hello world"
                data: "aGVsbG8gd29ybGQ=",
                mediaType: "text/plain",
                name: "notes.txt",
              },
            ],
          },
        ],
      });

      const args = firstCreateArgs();
      const userMsg = getMessage(args, 1);
      expect(userMsg.role).toBe("user");
      // No images → flattened to a single text string concatenating both parts.
      expect(typeof userMsg.content).toBe("string");
      expect(userMsg.content).toBe("summarize this:[document: notes.txt]\nhello world");
    });

    it("inlines text/* document with mediaType label when name is missing", async () => {
      const provider = setup();
      await provider.chat({
        model: "m",
        system: "sys",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: "base64",
                data: "aGVsbG8=",
                mediaType: "text/markdown",
              },
            ],
          },
        ],
      });

      const args = firstCreateArgs();
      const userMsg = getMessage(args, 1);
      expect(userMsg.content).toBe("[document: text/markdown]\nhello");
    });

    it("stubs binary documents (e.g. PDF) with a placeholder text", async () => {
      const provider = setup();
      await provider.chat({
        model: "m",
        system: "sys",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: "base64",
                data: "JVBERi0=",
                mediaType: "application/pdf",
                name: "report.pdf",
              },
            ],
          },
        ],
      });

      const args = firstCreateArgs();
      const userMsg = getMessage(args, 1);
      expect(userMsg.content).toBe(
        "[document: report.pdf — binary content not supported on this provider]",
      );
      // The base64 PDF bytes must NOT leak into the text payload.
      expect(JSON.stringify(userMsg)).not.toContain("JVBERi0");
    });

    it("truncates oversized text/* documents and appends an elision marker", async () => {
      const provider = setup();
      // 250k chars decoded — well past the 100k cap. Pad to the boundary so
      // the truncation decision is unambiguous (small variations from the
      // base64 alignment shouldn't matter for the assertion).
      const longText = "a".repeat(250_000);
      const base64 = Buffer.from(longText, "utf-8").toString("base64");

      await provider.chat({
        model: "m",
        system: "sys",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: "base64",
                data: base64,
                mediaType: "text/plain",
                name: "huge.txt",
              },
            ],
          },
        ],
      });

      const args = firstCreateArgs();
      const userMsg = getMessage(args, 1);
      expect(typeof userMsg.content).toBe("string");
      const text = userMsg.content as string;

      // Header preserved, elision marker appended.
      expect(text.startsWith("[document: huge.txt]\n")).toBe(true);
      expect(text).toContain("[Content truncated at 100000 characters]");

      // Total inlined length capped: 100k chars + the header + the marker.
      // Pin the bound generously to avoid coupling to exact lengths.
      expect(text.length).toBeLessThan(110_000);

      // Crucially: the full 250k payload did NOT make it through.
      expect(text.length).toBeLessThan(longText.length);
    });

    it("does NOT truncate or annotate small text/* documents", async () => {
      const provider = setup();
      const small = "hello world";
      await provider.chat({
        model: "m",
        system: "sys",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: "base64",
                data: Buffer.from(small, "utf-8").toString("base64"),
                mediaType: "text/plain",
                name: "small.txt",
              },
            ],
          },
        ],
      });

      const args = firstCreateArgs();
      const userMsg = getMessage(args, 1);
      expect(userMsg.content).toBe("[document: small.txt]\nhello world");
      // No spurious elision marker on a payload that didn't need truncating.
      expect(userMsg.content).not.toContain("truncated");
    });

    it("combines documents with images into multipart parts", async () => {
      const provider = setup();
      await provider.chat({
        model: "m",
        system: "sys",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see attached" },
              {
                type: "document",
                source: "base64",
                data: "aGk=",
                mediaType: "text/plain",
                name: "n.txt",
              },
              { type: "image", source: "base64", data: "aW1n", mediaType: "image/png" },
            ],
          },
        ],
      });

      const args = firstCreateArgs();
      const userMsg = getMessage(args, 1);
      expect(Array.isArray(userMsg.content)).toBe(true);
      const parts = userMsg.content as Array<{ type: string; text?: string; image_url?: unknown }>;
      // 2 text parts (caption + inlined document) + 1 image part
      expect(parts).toHaveLength(3);
      expect(parts[0]).toEqual({ type: "text", text: "see attached" });
      expect(parts[1]).toEqual({ type: "text", text: "[document: n.txt]\nhi" });
      expect(parts[2]).toMatchObject({ type: "image_url" });
    });
  });
});
