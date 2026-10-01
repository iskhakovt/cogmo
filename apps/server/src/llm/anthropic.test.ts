import { APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import { SpanStatusCode } from "@opentelemetry/api";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CorrectionExtractionSchema } from "../agent/evolution/extraction-schema.js";
import { logger } from "../logger.js";
import { expectDefined } from "../test/assertions.js";
import { drainFrames } from "../test/factories.js";
import { type OtelHarness, setupOtelHarness } from "../test/otel-harness.js";
import { AnthropicProvider, type AnthropicProviderOptions } from "./anthropic.js";
import { extractText } from "./content.js";
import { MissingToolCallError, ProviderProtocolError, ToolArgsCutOffError } from "./errors.js";
import { toObjectJsonSchema } from "./json-schema.js";
import { CLEARED_PLACEHOLDER } from "./tool-result-clearing.js";
import type {
  CacheIntent,
  ChatStreamFrame,
  CountTokensParams,
  Message,
  ResponseFormat,
  ToolDefinition,
  ToolResultClearing,
} from "./types.js";

// Mock the Anthropic client — use a class so `new Anthropic()` works — and
// keep the SDK's error classes.
const mockCreate = vi.fn();
const mockCountTokens = vi.fn();
// Constructor options each client was built with, newest last.
const clientOptions: Array<{ fetch?: typeof fetch }> = [];
vi.mock("@anthropic-ai/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/sdk")>()),
  default: class MockAnthropic {
    beta = { messages: { create: mockCreate, countTokens: mockCountTokens } };
    // As the SDK resolves it, less the `ANTHROPIC_BASE_URL` fallback, which
    // `resolver.test.ts` covers on the real client.
    baseURL: string;
    constructor(opts: { fetch?: typeof fetch; baseURL?: string }) {
      clientOptions.push(opts);
      this.baseURL = opts.baseURL || "https://api.anthropic.com";
    }
  },
}));

/** Create a mock async iterable that yields Anthropic stream events. */
function mockStream(events: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < events.length) return { value: events[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function createProvider(): AnthropicProvider {
  mockCreate.mockReset();
  mockCountTokens.mockReset();
  return new AnthropicProvider("test-key");
}

describe("AnthropicProvider", () => {
  it("maps a simple text response", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Hello!", citations: null }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 15, output_tokens: 8 },
    });

    const result = await provider.chat({
      model: "claude-sonnet-4-6",
      system: "Be helpful",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 8 });
  });

  it("omits the system field when the system prompt is empty", async () => {
    // Anthropic rejects an empty-text content block; a null-persona sub-agent
    // passes system: "". The adapter must drop the field, not send "".
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok", citations: null }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    await provider.chat({
      model: "claude-sonnet-4-6",
      system: "",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(mockCreate.mock.calls[0]?.[0].system).toBeUndefined();
  });

  it("sends a non-empty system prompt as a cached text block", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok", citations: null }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    await provider.chat({
      model: "claude-sonnet-4-6",
      system: "Be terse.",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(mockCreate.mock.calls[0]?.[0].system).toEqual([
      { type: "text", text: "Be terse.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("maps a tool_use response", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "tool_use", id: "tu_123", name: "get_time", input: {}, caller: { type: "direct" } },
      ],
      stop_reason: "tool_use",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 20, output_tokens: 12 },
    });

    const result = await provider.chat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user", content: "what time?" }],
    });

    expect(result.stopReason).toBe("tool_use");
    expect(result.content).toEqual([
      { type: "tool_use", id: "tu_123", name: "get_time", input: {} },
    ]);
  });

  it("maps thinking blocks in response", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "thinking", thinking: "hmm...", signature: "sig123" },
        { type: "text", text: "answer", citations: null },
      ],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await provider.chat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user", content: "think" }],
    });

    expect(result.content).toEqual([
      { type: "thinking", thinking: "hmm...", signature: "sig123" },
      { type: "text", text: "answer" },
    ]);
  });

  it("skips unknown block types", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "server_tool_use", id: "stu_1", name: "analyze", input: {} },
        { type: "text", text: "answer", citations: null },
      ],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await provider.chat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user", content: "think" }],
    });

    expect(result.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("passes tools to the API when provided", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok", citations: null }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await provider.chat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "my_tool",
          description: "does things",
          parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
        },
      ],
    });

    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools[0].name).toBe("my_tool");
    expect(callArgs.tools[0].input_schema.type).toBe("object");
    expect(callArgs.tools[0].input_schema.properties).toEqual({ x: { type: "string" } });
  });

  it("carries a tool's definitions so its $refs resolve", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok", citations: null }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const $defs = { Point: { type: "object", properties: { x: { type: "number" } } } };
    const definitions = { Size: { type: "integer" } };

    await provider.chat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "plot",
          description: "plots a point",
          parameters: {
            type: "object",
            properties: { at: { $ref: "#/$defs/Point" }, size: { $ref: "#/definitions/Size" } },
            $defs,
            definitions,
          },
        },
      ],
    });

    const tool = expectDefined(mockCreate.mock.calls[0], "create call")[0].tools[0];
    expect(tool.input_schema).toMatchObject({ $defs, definitions });
  });

  it("translates tool_result blocks correctly", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "done", citations: null }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await provider.chat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [
        { role: "user", content: "use tool" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "test", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "tu_1", content: "result data" }],
        },
      ],
    });

    const callArgs = mockCreate.mock.calls[0]![0];
    const toolResultMsg = callArgs.messages[2];
    const block = toolResultMsg.content[0];
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("tu_1");
    expect(block.content).toBe("result data");
  });

  it("translates tool_result with isError correctly", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok", citations: null }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await provider.chat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "tu_1", content: "Error: boom", isError: true },
          ],
        },
      ],
    });

    const block = mockCreate.mock.calls[0]![0].messages[0].content[0];
    expect(block.is_error).toBe(true);
  });

  it("omits is_error when isError is undefined", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok", citations: null }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await provider.chat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "tu_1", content: "success" }],
        },
      ],
    });

    const block = mockCreate.mock.calls[0]![0].messages[0].content[0];
    expect(block).not.toHaveProperty("is_error");
  });

  it("never puts a harness tag on the wire", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok", citations: null }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await provider.chat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "x", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "tu_1", content: "stop", harness: "volume_nudge" },
            { type: "text", text: "Please complete your response.", harness: "continuation" },
          ],
        },
      ],
    });

    const sent = expectDefined(mockCreate.mock.calls[0], "messages.create call")[0].messages;
    expect(JSON.stringify(sent)).not.toContain("harness");
    expect(sent[2].content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: "stop" },
      { type: "text", text: "Please complete your response." },
    ]);
  });

  it("uses default max_tokens when not specified", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok", citations: null }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await provider.chat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });

    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.max_tokens).toBe(8192);
  });

  it("maps max_tokens stop reason", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "truncat", citations: null }],
      stop_reason: "max_tokens",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 100 },
    });

    const result = await provider.chat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user", content: "write a novel" }],
    });

    expect(result.stopReason).toBe("max_tokens");
  });

  it("maps model_context_window_exceeded to context_overflow, not max_tokens", async () => {
    // The overflow has to stay distinguishable from every other stop reason
    // downstream. `end_turn` would match `classifyPostStream`'s empty-turn
    // arm and earn a continuation prompt; `max_tokens` reads as a normal
    // completion and lets a contentless turn persist as the model's answer.
    // Only its own member routes the turn to the degraded off-ramp.
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [],
      stop_reason: "model_context_window_exceeded",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 900_000, output_tokens: 0 },
    });

    const result = await provider.chat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user", content: "a very long conversation" }],
    });

    expect(result.stopReason).toBe("context_overflow");
    expect(result.content).toEqual([]);
  });

  it("maps model_context_window_exceeded in stream", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce(
      mockStream([
        {
          type: "message_start",
          message: {
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 900_000, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "model_context_window_exceeded" },
          usage: { output_tokens: 0 },
        },
        { type: "message_stop" },
      ]),
    );

    const { meta } = await drainFrames(
      provider.chatStream({
        model: "claude-sonnet-4-6",
        system: "sys",
        messages: [{ role: "user", content: "a very long conversation" }],
      }),
    );
    expect(meta.stopReason).toBe("context_overflow");
  });

  it.each([
    ["stop_sequence", "end_turn"],
    ["pause_turn", "end_turn"],
    ["compaction", "end_turn"],
  ] as const)("maps %s stop reason to %s", async (anthropicReason, expected) => {
    // These arms are named explicitly rather than left to a catch-all so the
    // switch stays exhaustive over the SDK union — the compile error on the
    // next added stop reason is the whole point.
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "partial", citations: null }],
      stop_reason: anthropicReason,
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 4 },
    });

    const result = await provider.chat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.stopReason).toBe(expected);
  });

  it("maps refusal stop reason", async () => {
    // Anthropic surfaces explicit policy refusals on recent models as
    // `stop_reason: "refusal"`. The Class C subtype in
    // design/agent-resilience.md depends on this signal reaching the
    // in-loop classifier, so the mapping must be 1:1 — no default fallthrough
    // to "end_turn".
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "I can't help with that.", citations: null }],
      stop_reason: "refusal",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 20, output_tokens: 8 },
    });

    const result = await provider.chat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user", content: "do something disallowed" }],
    });

    expect(result.stopReason).toBe("refusal");
  });

  it("maps refusal stop reason in stream", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce(
      mockStream([
        {
          type: "message_start",
          message: {
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 20, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "I can't help with that." },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "refusal" },
          usage: { output_tokens: 8 },
        },
        { type: "message_stop" },
      ]),
    );

    const { meta } = await drainFrames(
      provider.chatStream({
        model: "claude-sonnet-4-6",
        system: "sys",
        messages: [{ role: "user", content: "do something disallowed" }],
      }),
    );
    expect(meta.stopReason).toBe("refusal");
  });

  describe("chatStream", () => {
    const defaultParams = {
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user" as const, content: "hi" }],
    };

    it("yields text_delta events for text content", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: {
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ]),
      );

      const { frames, meta } = await drainFrames(provider.chatStream(defaultParams));

      expect(frames).toEqual([
        { type: "text_delta", text: "Hello" },
        { type: "text_delta", text: " world" },
      ]);

      expect(meta.stopReason).toBe("end_turn");
      expect(meta.model).toBe("claude-sonnet-4-6");
      expect(meta.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("yields tool_start with empty input when the stream emits no input_json_delta (zero-arg tool)", async () => {
      // Anthropic streaming omits input_json_delta for tools called
      // with no arguments; non-streaming returns input: {}. Match the
      // non-streaming shape so zero-arg tools don't burn the
      // stream-truncation repair budget.
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: {
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tu_zero", name: "btc_spot" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ]),
      );
      const { frames, meta } = await drainFrames(provider.chatStream(defaultParams));
      expect(frames).toEqual([{ type: "tool_start", id: "tu_zero", name: "btc_spot", input: {} }]);
      expect(meta.stopReason).toBe("tool_use");
    });

    it("accumulates tool input and yields tool_start on block stop", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: {
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tu_1", name: "web_search" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"quer' },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: 'y":"weather"}' },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 12 },
          },
          { type: "message_stop" },
        ]),
      );

      const { frames, meta } = await drainFrames(provider.chatStream(defaultParams));

      expect(frames).toEqual([
        { type: "tool_start", id: "tu_1", name: "web_search", input: { query: "weather" } },
      ]);

      expect(meta.stopReason).toBe("tool_use");
    });

    it("handles mixed text and tool_use in correct order", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: {
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Let me search." },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "tu_1", name: "search" },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"q":"test"}' },
          },
          { type: "content_block_stop", index: 1 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 15 },
          },
          { type: "message_stop" },
        ]),
      );

      const { frames } = await drainFrames(provider.chatStream(defaultParams));

      expect(frames.map((frame) => frame.type)).toEqual(["text_delta", "tool_start"]);
    });

    it("passes stream: true to the API", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: {
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 0 },
          },
          { type: "message_stop" },
        ]),
      );

      await drainFrames(provider.chatStream(defaultParams));

      const callArgs = mockCreate.mock.calls[0]![0];
      expect(callArgs.stream).toBe(true);
    });

    it("repairs trailing-comma JSON in tool args via jsonrepair before declaring failure (Anthropic stream)", async () => {
      const provider = createProvider();
      // Buffered chunks reconstruct to `{"query":"weather",}` — valid after
      // jsonrepair strips the trailing comma, parses as { query: "weather" }.
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: {
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tu_1", name: "web_search" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"query":"weather",' },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "}" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 12 },
          },
          { type: "message_stop" },
        ]),
      );

      const { frames, meta } = await drainFrames(provider.chatStream(defaultParams));

      expect(frames).toEqual([
        { type: "tool_start", id: "tu_1", name: "web_search", input: { query: "weather" } },
      ]);
      expect(meta.stopReason).toBe("tool_use");
    });

    it("throws ProviderProtocolError on tool-arg JSON unrepairable by jsonrepair (Anthropic stream)", async () => {
      const provider = createProvider();
      // `}}}]]]` — closers-only with no payload. There is nothing for any
      // future jsonrepair heuristic to wrap, so this stays unrepairable
      // across library upgrades; a more typo-shaped input could silently
      // start passing if jsonrepair broadens its recovery surface.
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: {
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tu_1", name: "web_search" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "}}}]]]" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 12 },
          },
          { type: "message_stop" },
        ]),
      );

      await expect(drainFrames(provider.chatStream(defaultParams))).rejects.toBeInstanceOf(
        ProviderProtocolError,
      );
    });

    // The parse failure is held until the stream says whether the cap cut the
    // block off: only a `max_tokens` stop straight after the failed block is
    // unfinished JSON. A later block means the model wrote malformed JSON.
    it.each([
      {
        label: "stops at max_tokens right after the failed block",
        tail: [
          {
            type: "message_delta",
            delta: { stop_reason: "max_tokens" },
            usage: { output_tokens: 12 },
          },
        ],
        cutOff: true,
      },
      {
        label: "ends its turn normally",
        tail: [
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 12 },
          },
        ],
        cutOff: false,
      },
      {
        label: "goes on to another block before hitting the cap",
        tail: [
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
          {
            type: "message_delta",
            delta: { stop_reason: "max_tokens" },
            usage: { output_tokens: 12 },
          },
        ],
        cutOff: false,
      },
    ])(
      "reports unparseable tool args as cut off only when the stream $label",
      async ({ tail, cutOff }) => {
        const provider = createProvider();
        mockCreate.mockResolvedValueOnce(
          mockStream([
            {
              type: "message_start",
              message: {
                model: "claude-sonnet-4-6",
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "tu_1", name: "write_file" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: "}}}]]]" },
            },
            { type: "content_block_stop", index: 0 },
            ...tail,
            { type: "message_stop" },
          ]),
        );

        const collected: ChatStreamFrame[] = [];
        const drained = (async () => {
          for await (const frame of provider.chatStream(defaultParams)) collected.push(frame);
        })();

        const error = await drained.then(
          () => undefined,
          (err: unknown) => err,
        );
        expect(error).toBeInstanceOf(ProviderProtocolError);
        expect(error instanceof ToolArgsCutOffError).toBe(cutOff);
        // Nothing from the failed block or after it reaches the consumer.
        expect(collected).toEqual([]);
      },
    );
  });

  describe("abort signal", () => {
    const params = {
      model: "claude-sonnet-5",
      system: "sys",
      messages: [{ role: "user" as const, content: "hi" }],
    };

    /** An SDK call that, like the SDK's own, rejects with `APIUserAbortError` once its signal fires. */
    function sdkCallUntilAborted(_body: unknown, options: { signal: AbortSignal }): Promise<never> {
      return new Promise((_resolve, reject) => {
        const abort = (): void => reject(new APIUserAbortError());
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
      });
    }

    it("hands the signal to the SDK", async () => {
      const provider = createProvider();
      const signal = new AbortController().signal;
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok", citations: null }],
        stop_reason: "end_turn",
        model: "claude-sonnet-5",
        usage: { input_tokens: 5, output_tokens: 1 },
      });
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: { model: "claude-sonnet-5", usage: { input_tokens: 5, output_tokens: 0 } },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
        ]),
      );

      await provider.chat(params, { signal });
      await drainFrames(provider.chatStream(params, { signal }));

      expect(mockCreate.mock.calls.map((call) => call[1])).toEqual([{ signal }, { signal }]);
    });

    it("rejects chat with the signal's reason, not the SDK's abort error", async () => {
      const provider = createProvider();
      const controller = new AbortController();
      const reason = new Error("cancelled");
      mockCreate.mockImplementationOnce(sdkCallUntilAborted);

      const call = provider.chat(params, { signal: controller.signal });
      controller.abort(reason);

      await expect(call).rejects.toBe(reason);
    });

    it("throws the signal's reason, not the SDK's abort error, from a stream not yet open", async () => {
      const provider = createProvider();
      const controller = new AbortController();
      const reason = new Error("cancelled");
      mockCreate.mockImplementationOnce(sdkCallUntilAborted);

      const drained = drainFrames(provider.chatStream(params, { signal: controller.signal }));
      controller.abort(reason);

      await expect(drained).rejects.toBe(reason);
    });

    it("throws the signal's reason, not a done frame, when the SDK ends an aborted stream", async () => {
      const provider = createProvider();
      const controller = new AbortController();
      const reason = new Error("cancelled");
      async function* sdkStream(): AsyncGenerator<unknown> {
        yield {
          type: "message_start",
          message: { model: "claude-sonnet-5", usage: { input_tokens: 5, output_tokens: 0 } },
        };
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } };
        // The SDK's stream ends quietly once its signal fires.
        controller.abort(reason);
      }
      mockCreate.mockResolvedValueOnce(sdkStream());

      const collected: ChatStreamFrame[] = [];
      const drained = (async () => {
        for await (const frame of provider.chatStream(params, { signal: controller.signal })) {
          collected.push(frame);
        }
      })();

      await expect(drained).rejects.toBe(reason);
      expect(collected).toEqual([{ type: "text_delta", text: "Hel" }]);
    });

    it("yields none of the events the SDK had buffered when the signal fired", async () => {
      // The SDK yields every event already parsed from the current network
      // chunk before its read of the next one sees the abort.
      const provider = createProvider();
      const controller = new AbortController();
      const reason = new Error("cancelled");
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: { model: "claude-sonnet-5", usage: { input_tokens: 5, output_tokens: 0 } },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "tu_1", name: "search" },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
          },
          { type: "content_block_stop", index: 1 },
        ]),
      );

      const collected: ChatStreamFrame[] = [];
      const drained = (async () => {
        for await (const frame of provider.chatStream(params, { signal: controller.signal })) {
          collected.push(frame);
          controller.abort(reason);
        }
      })();

      await expect(drained).rejects.toBe(reason);
      expect(collected).toEqual([{ type: "text_delta", text: "Hel" }]);
    });
  });

  describe("abandoned stream", () => {
    let harness: OtelHarness;

    beforeAll(() => {
      harness = setupOtelHarness();
    });

    beforeEach(async () => {
      await harness.reset();
    });

    afterAll(async () => {
      await harness.shutdown();
    });

    const params = {
      model: "claude-sonnet-5",
      system: "sys",
      messages: [{ role: "user" as const, content: "hi" }],
    };

    it("returns the SDK stream, which aborts the request, and fails the span", async () => {
      const provider = createProvider();
      const returned = vi.fn();
      async function* sdkStream(): AsyncGenerator<unknown> {
        try {
          yield {
            type: "message_start",
            message: { model: "claude-sonnet-5", usage: { input_tokens: 5, output_tokens: 0 } },
          };
          yield {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          };
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hel" },
          };
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "lo" },
          };
        } finally {
          // Where the SDK's stream aborts its request when returned early.
          returned();
        }
      }
      mockCreate.mockResolvedValueOnce(sdkStream());

      for await (const _ of provider.chatStream(params)) break;

      expect(returned).toHaveBeenCalledOnce();
      const span = expectDefined(harness.getSpans()[0], "chat span");
      expect(harness.getSpans()).toHaveLength(1);
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    });

    it("starts no request and no span for a stream never read", () => {
      const provider = createProvider();

      provider.chatStream(params);

      expect(mockCreate).not.toHaveBeenCalled();
      expect(harness.startedSpanCount()).toBe(0);
    });
  });

  describe("prompt caching", () => {
    it("sends system as content block array with cache_control", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok", citations: null }],
        stop_reason: "end_turn",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.chat({
        model: "claude-sonnet-4-6",
        system: "Be helpful",
        messages: [{ role: "user", content: "hi" }],
      });

      const callArgs = mockCreate.mock.calls[0]![0];
      expect(callArgs.system).toEqual([
        { type: "text", text: "Be helpful", cache_control: { type: "ephemeral" } },
      ]);
    });

    it("adds cache_control to the last tool", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok", citations: null }],
        stop_reason: "end_turn",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.chat({
        model: "claude-sonnet-4-6",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { name: "a", description: "first", parameters: { type: "object" } },
          { name: "b", description: "second", parameters: { type: "object" } },
        ],
      });

      const callArgs = mockCreate.mock.calls[0]![0];
      expect(callArgs.tools[0].cache_control).toBeUndefined();
      expect(callArgs.tools[1].cache_control).toEqual({ type: "ephemeral" });
    });

    it("reports cache tokens in usage", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok", citations: null }],
        stop_reason: "end_turn",
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 0,
        },
      });

      const result = await provider.chat({
        model: "claude-sonnet-4-6",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result.usage.cacheReadTokens).toBe(5000);
      expect(result.usage.cacheCreationTokens).toBe(0);
    });
  });

  // Anthropic's `input_tokens` counts only what follows the last breakpoint.
  // The canonical `inputTokens` is the whole prompt, with cache reads and
  // writes as subsets of it — the compaction fast path reads it as the
  // conversation's size.
  describe("usage totals", () => {
    it("adds cache reads and writes into inputTokens on a non-streaming response", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok", citations: null }],
        stop_reason: "end_turn",
        model: "claude-sonnet-5",
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 300,
        },
      });

      const result = await provider.chat({
        model: "claude-sonnet-5",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result.usage).toEqual({
        inputTokens: 5350,
        outputTokens: 10,
        cacheReadTokens: 5000,
        cacheCreationTokens: 300,
      });
    });

    it("adds cache reads and writes into inputTokens on a stream", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: {
              model: "claude-sonnet-5",
              usage: {
                input_tokens: 12,
                output_tokens: 1,
                cache_read_input_tokens: 7360,
                cache_creation_input_tokens: 68,
              },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 9 },
          },
        ]),
      );

      const { meta } = await drainFrames(
        provider.chatStream({
          model: "claude-sonnet-5",
          system: "sys",
          messages: [{ role: "user", content: "hi" }],
        }),
      );

      expect(meta.usage).toEqual({
        inputTokens: 7440,
        outputTokens: 9,
        cacheReadTokens: 7360,
        cacheCreationTokens: 68,
      });
    });

    it("treats null cache fields as zero and leaves them off the usage", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok", citations: null }],
        stop_reason: "end_turn",
        model: "claude-sonnet-5",
        usage: {
          input_tokens: 40,
          output_tokens: 3,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      });

      const result = await provider.chat({
        model: "claude-sonnet-5",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 3 });
    });
  });

  describe("cache intent", () => {
    const TOOLS: ToolDefinition[] = [
      { name: "a", description: "first", parameters: { type: "object" } },
      { name: "b", description: "second", parameters: { type: "object" } },
    ];

    function okResponse(): unknown {
      return {
        content: [{ type: "text", text: "ok", citations: null }],
        stop_reason: "end_turn",
        model: "claude-sonnet-5",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    }

    async function sentWith(cache: CacheIntent | undefined): Promise<Record<string, unknown>> {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(okResponse());
      await provider.chat({
        model: "claude-sonnet-5",
        system: "sys",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "text", text: "hello" }] },
          { role: "user", content: [{ type: "text", text: "again" }] },
        ],
        tools: TOOLS,
        ...(cache && { cache }),
      });
      return expectDefined(mockCreate.mock.calls[0], "create call")[0];
    }

    /** Every `cache_control` value in a request body, the top-level field included. */
    function breakpoints(value: unknown): unknown[] {
      if (Array.isArray(value)) return value.flatMap(breakpoints);
      if (typeof value !== "object" || value === null) return [];
      return Object.entries(value).flatMap(([key, inner]) =>
        key === "cache_control" ? [inner] : breakpoints(inner),
      );
    }

    it("without an intent, marks tools and system at the default TTL and sends no top-level field", async () => {
      const body = await sentWith(undefined);

      expect(body).not.toHaveProperty("cache_control");
      expect(body.system).toEqual([
        { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
      ]);
      expect(breakpoints(body.tools)).toEqual([{ type: "ephemeral" }]);
      expect(breakpoints(body.messages)).toEqual([]);
    });

    it.each([
      ["short", "5m"],
      ["long", "1h"],
    ] as const)(
      "a %s intent caches the transcript at %s, with tools and system at the same TTL",
      async (retention, ttl) => {
        const body = await sentWith({ key: "conv-1", retention });
        const marker = { type: "ephemeral", ttl };

        // Top-level automatic caching places the transcript breakpoint.
        expect(body.cache_control).toEqual(marker);
        expect(body.system).toEqual([{ type: "text", text: "sys", cache_control: marker }]);
        const tools = z.array(z.record(z.string(), z.unknown())).parse(body.tools);
        expect(tools[0]).not.toHaveProperty("cache_control");
        expect(tools[1]?.cache_control).toEqual(marker);
        // Nothing in the messages themselves: the server moves the automatic
        // breakpoint to the last cacheable block.
        expect(breakpoints(body.messages)).toEqual([]);
        // Three of the four slots, all at one TTL — a longer TTL after a
        // shorter one is a 400.
        const all = breakpoints(body);
        expect(all.length).toBeLessThanOrEqual(4);
        expect(all).toEqual([marker, marker, marker]);
      },
    );

    it("maps the intent the same way on the streaming path", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: { model: "claude-sonnet-5", usage: { input_tokens: 5, output_tokens: 0 } },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
        ]),
      );

      await drainFrames(
        provider.chatStream({
          model: "claude-sonnet-5",
          system: "sys",
          messages: [{ role: "user", content: "hi" }],
          tools: TOOLS,
          cache: { key: "conv-1", retention: "long" },
        }),
      );

      const body = expectDefined(mockCreate.mock.calls[0], "create call")[0];
      expect(body.stream).toBe(true);
      expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
      expect(breakpoints(body)).toEqual([
        { type: "ephemeral", ttl: "1h" },
        { type: "ephemeral", ttl: "1h" },
        { type: "ephemeral", ttl: "1h" },
      ]);
    });

    it("takes no transcript caching on the responseFormat path", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: '{"ok":true}', citations: null }],
        stop_reason: "end_turn",
        model: "claude-sonnet-5",
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.chat({
        model: "claude-sonnet-5",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        responseFormat: {
          type: "json_schema",
          name: "extract",
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
        cache: { key: "conv-1", retention: "long" },
      });

      const body = expectDefined(mockCreate.mock.calls[0], "create call")[0];
      expect(body).not.toHaveProperty("cache_control");
      expect(breakpoints(body)).toEqual([{ type: "ephemeral" }]);
    });

    it("takes no cache intent on countTokens, and sends no top-level cache_control if handed one", async () => {
      const provider = createProvider();
      mockCountTokens.mockResolvedValueOnce({ input_tokens: 100 });

      await provider.countTokens({
        model: "claude-sonnet-5",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: TOOLS,
        // @ts-expect-error — nothing re-sends a count's transcript, so the type has no intent
        cache: { key: "conv-1", retention: "long" },
      });

      const body = expectDefined(mockCountTokens.mock.calls[0], "countTokens call")[0];
      expect(body).not.toHaveProperty("cache_control");
    });
  });

  describe("injected fetch", () => {
    it("sends requests through the injected fetch, wrapped in the failure logger", async () => {
      const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
        return new Response('{"type":"error"}', { status: 500 });
      });
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        new AnthropicProvider("test-key", undefined, { fetch: inner });
        const sdkFetch = expectDefined(clientOptions.at(-1)?.fetch, "fetch handed to the SDK");

        const res = await sdkFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          body: "{}",
        });

        expect(res.status).toBe(500);
        expect(inner).toHaveBeenCalledOnce();
        expect(errorSpy).toHaveBeenCalledWith(
          expect.objectContaining({ providerName: "anthropic", status: 500 }),
          "llm request failed",
        );
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe("countTokens", () => {
    it("calls the Anthropic countTokens API and returns input_tokens", async () => {
      const provider = createProvider();
      mockCountTokens.mockResolvedValueOnce({ input_tokens: 1234 });

      const count = await provider.countTokens({
        model: "claude-sonnet-4-6",
        system: "You are helpful.",
        messages: [{ role: "user", content: "hello" }],
      });

      expect(count).toBe(1234);
      expect(mockCountTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hello" }],
        }),
      );
    });

    it("passes tools through when provided", async () => {
      const provider = createProvider();
      mockCountTokens.mockResolvedValueOnce({ input_tokens: 500 });

      await provider.countTokens({
        model: "claude-sonnet-4-6",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "search", description: "Search the web", parameters: { type: "object" } }],
      });

      expect(mockCountTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.arrayContaining([expect.objectContaining({ name: "search" })]),
        }),
      );
    });

    it("omits tools when not provided", async () => {
      const provider = createProvider();
      mockCountTokens.mockResolvedValueOnce({ input_tokens: 100 });

      await provider.countTokens({
        model: "claude-sonnet-4-6",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      });

      const firstCall = mockCountTokens.mock.calls[0];
      if (!firstCall) throw new Error("expected countTokens to have been called");
      const callArgs = firstCall[0] as { tools?: unknown };
      expect(callArgs.tools).toBeUndefined();
    });
  });

  describe("edit intent and binding controls", () => {
    const CLEARING: ToolResultClearing = {
      triggerTokens: 60_000,
      keep: 5,
      clearAtLeastTokens: 10_000,
    };
    const CLEAR_TOOL_USES = {
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: 60_000 },
          keep: { type: "tool_uses", value: 5 },
          clear_at_least: { type: "input_tokens", value: 10_000 },
        },
      ],
    };
    const BINDING = "thinking-binding-controls-2026-08-01";
    const CONTEXT_MANAGEMENT = "context-management-2025-06-27";

    const BodySchema = z.looseObject({
      tools: z.array(z.unknown()).optional(),
      betas: z.array(z.string()).optional(),
      context_management: z.unknown().optional(),
      thinking: z.unknown().optional(),
    });

    function provider(baseURL?: string, options?: AnthropicProviderOptions): AnthropicProvider {
      mockCreate.mockReset();
      mockCountTokens.mockReset();
      return new AnthropicProvider("test-key", baseURL, options);
    }

    const PARAMS = {
      system: "sys",
      messages: [{ role: "user" as const, content: "hi" }],
    };

    /** The body each of the three request kinds hands the SDK, for `params`. */
    async function sentBodies(
      p: AnthropicProvider,
      params: CountTokensParams,
    ): Promise<{
      chat: z.infer<typeof BodySchema>;
      stream: z.infer<typeof BodySchema>;
      count: z.infer<typeof BodySchema>;
    }> {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok", citations: null }],
        stop_reason: "end_turn",
        model: params.model,
        usage: { input_tokens: 5, output_tokens: 1 },
      });
      await p.chat(params);
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: { model: params.model, usage: { input_tokens: 5, output_tokens: 0 } },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
        ]),
      );
      await drainFrames(p.chatStream(params));
      mockCountTokens.mockResolvedValueOnce({ input_tokens: 5 });
      await p.countTokens(params);
      return {
        chat: BodySchema.parse(expectDefined(mockCreate.mock.calls[0], "chat call")[0]),
        stream: BodySchema.parse(expectDefined(mockCreate.mock.calls[1], "stream call")[0]),
        count: BodySchema.parse(expectDefined(mockCountTokens.mock.calls[0], "count call")[0]),
      };
    }

    it("sends the Strategy 1 intent as context_management on every request and to countTokens", async () => {
      const bodies = await sentBodies(provider(), {
        model: "claude-sonnet-5",
        ...PARAMS,
        clearToolResults: CLEARING,
      });

      for (const body of Object.values(bodies)) {
        expect(body.context_management).toEqual(CLEAR_TOOL_USES);
        expect(body.betas).toContain(CONTEXT_MANAGEMENT);
      }
    });

    it("sends no context_management, and not its beta, without an intent", async () => {
      const bodies = await sentBodies(provider(), { model: "claude-sonnet-5", ...PARAMS });

      for (const body of Object.values(bodies)) {
        expect(body).not.toHaveProperty("context_management");
        expect(body.betas ?? []).not.toContain(CONTEXT_MANAGEMENT);
      }
    });

    it("carries the intent on the structured-output path", async () => {
      const p = provider();
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: '{"ok":true}', citations: null }],
        stop_reason: "end_turn",
        model: "claude-sonnet-5",
        usage: { input_tokens: 5, output_tokens: 1 },
      });

      await p.chat({
        model: "claude-sonnet-5",
        ...PARAMS,
        clearToolResults: CLEARING,
        responseFormat: {
          type: "json_schema",
          name: "extract",
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      });

      const body = BodySchema.parse(expectDefined(mockCreate.mock.calls[0], "create call")[0]);
      expect(body.context_management).toEqual(CLEAR_TOOL_USES);
    });

    it("carries the intent and the header on the synthetic-tool path", async () => {
      const p = provider();
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "extract",
            input: { labels: { a: "b" } },
            caller: { type: "direct" },
          },
        ],
        stop_reason: "tool_use",
        model: "claude-sonnet-5",
        usage: { input_tokens: 5, output_tokens: 1 },
      });

      await p.chat({
        model: "claude-sonnet-5",
        ...PARAMS,
        clearToolResults: CLEARING,
        responseFormat: {
          type: "json_schema",
          name: "extract",
          // A record is an open object, which structured outputs can't take.
          schema: toObjectJsonSchema(z.object({ labels: z.record(z.string(), z.string()) })),
        },
      });

      const body = BodySchema.parse(expectDefined(mockCreate.mock.calls[0], "create call")[0]);
      expect(body.tools).toEqual([expect.objectContaining({ name: "extract" })]);
      expect(body.context_management).toEqual(CLEAR_TOOL_USES);
      expect(body.betas).toEqual([CONTEXT_MANAGEMENT, BINDING]);
    });

    it.each([
      ["no base URL", undefined, undefined],
      ["an empty base URL, which the SDK resolves to its own", "", undefined],
      ["Anthropic's own base URL", "https://api.anthropic.com", undefined],
      ["Anthropic's own base URL with a path", "https://api.anthropic.com/", undefined],
      ["Anthropic's own host in capitals", "https://API.ANTHROPIC.COM", undefined],
      ["Anthropic's own host over http", "http://api.anthropic.com", undefined],
      ["a base URL marked first-party", "http://127.0.0.1:4010", { firstParty: true }],
    ] as const)("sends the binding-controls header to %s", async (_label, baseURL, options) => {
      const bodies = await sentBodies(provider(baseURL, options), {
        model: "claude-sonnet-5",
        ...PARAMS,
      });

      for (const body of Object.values(bodies)) expect(body.betas).toEqual([BINDING]);
    });

    it.each([
      "https://openrouter.ai/api",
      // Ends in `anthropic.com` without being Anthropic's API.
      "https://api.notanthropic.com",
    ])(
      "sends %s no request controls: no betas, context_management or block_binding",
      async (baseURL) => {
        const bodies = await sentBodies(
          provider(baseURL, { prefixMismatchBehavior: "drop_block" }),
          { model: "claude-opus-5-5", ...PARAMS, clearToolResults: CLEARING },
        );

        for (const body of Object.values(bodies)) {
          expect(body).not.toHaveProperty("betas");
          expect(body).not.toHaveProperty("thinking");
          expect(body).not.toHaveProperty("context_management");
        }
      },
    );

    it("clears a third-party endpoint's tool results on the wire, the same in body and count", async () => {
      const result = "line of output from the tool\n".repeat(40);
      const messages: Message[] = [
        { role: "user", content: "read the logs" },
        ...[1, 2, 3].flatMap((n): Message[] => [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: `t${n}`, name: "read", input: { part: n } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", toolUseId: `t${n}`, content: `${n}: ${result}` }],
          },
        ]),
        { role: "user", content: "summarize" },
      ];
      const before = structuredClone(messages);

      const bodies = await sentBodies(provider("https://openrouter.ai/api"), {
        model: "claude-opus-5-5",
        system: "sys",
        messages,
        clearToolResults: { triggerTokens: 100, keep: 1, clearAtLeastTokens: 50 },
      });

      const ResultsSchema = z.looseObject({
        messages: z.array(
          z.looseObject({
            content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]),
          }),
        ),
      });
      const results = (body: unknown) =>
        ResultsSchema.parse(body).messages.flatMap((m) =>
          typeof m.content === "string"
            ? []
            : m.content.filter((b) => b.type === "tool_result").map((b) => b.content),
        );
      for (const body of Object.values(bodies)) {
        expect(results(body)).toEqual([CLEARED_PLACEHOLDER, CLEARED_PLACEHOLDER, `3: ${result}`]);
      }
      expect(messages).toEqual(before);
    });

    it("warns that a third-party endpoint ignores prefixMismatchBehavior", () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        provider("https://openrouter.ai/api", { prefixMismatchBehavior: "drop_block" });
        provider("https://openrouter.ai/api");
        provider(undefined, { prefixMismatchBehavior: "drop_block" });

        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(
          { baseURL: "https://openrouter.ai/api", prefixMismatchBehavior: "drop_block" },
          expect.stringContaining("ignoring prefixMismatchBehavior"),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it.each([
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5-5",
      "claude-sonnet-5-5-20261001",
    ])("sends block_binding with adaptive thinking to %s", async (model) => {
      const bodies = await sentBodies(provider(undefined, { prefixMismatchBehavior: "error" }), {
        model,
        ...PARAMS,
      });

      for (const body of Object.values(bodies)) {
        expect(body.thinking).toEqual({
          type: "adaptive",
          block_binding: { prefix_mismatch_behavior: "error" },
        });
        expect(body.betas).toContain(BINDING);
      }
    });

    it.each(["claude-sonnet-5", "claude-haiku-4-5", "claude-mythos-5-1", "claude-opus-5"])(
      "sends no thinking parameter to %s, which runs no prefix check",
      async (model) => {
        const bodies = await sentBodies(
          provider(undefined, { prefixMismatchBehavior: "drop_block" }),
          { model, ...PARAMS },
        );

        for (const body of Object.values(bodies)) {
          expect(body).not.toHaveProperty("thinking");
          expect(body.betas).toEqual([BINDING]);
        }
      },
    );

    it("sends no thinking parameter when the provider row sets no behaviour", async () => {
      const bodies = await sentBodies(provider(), { model: "claude-opus-5-5", ...PARAMS });

      for (const body of Object.values(bodies)) expect(body).not.toHaveProperty("thinking");
    });
  });

  describe("thinking", () => {
    it("sends no thinking parameter, leaving each model its own default", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: "thinking", thinking: "Let me reason...", signature: "sig" },
          { type: "text", text: "answer", citations: null },
        ],
        stop_reason: "end_turn",
        model: "claude-sonnet-5",
        usage: { input_tokens: 50, output_tokens: 30 },
      });

      await provider.chat({
        model: "claude-sonnet-5",
        system: "sys",
        messages: [{ role: "user", content: "think hard" }],
      });

      const callArgs = mockCreate.mock.calls[0]![0];
      expect(callArgs.thinking).toBeUndefined();
      expect(callArgs.max_tokens).toBe(8192);
    });

    it("translates thinking blocks in history back to Anthropic format", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok", citations: null }],
        stop_reason: "end_turn",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.chat({
        model: "claude-sonnet-4-6",
        system: "sys",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "previous reasoning", signature: "sig" },
              { type: "text", text: "previous answer" },
            ],
          },
          { role: "user", content: "follow up" },
        ],
      });

      const callArgs = mockCreate.mock.calls[0]![0];
      const assistantMsg = callArgs.messages[0];
      expect(assistantMsg.content[0]).toEqual({
        type: "thinking",
        thinking: "previous reasoning",
        signature: "sig",
      });
    });

    it("captures the signature from signature_delta, not content_block_start", async () => {
      // The signature arrives as its own delta just before
      // `content_block_stop`; `content_block_start` carries an empty one.
      // Reading only the start event yields a block the API rejects on
      // replay as a modified thinking block.
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: { model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 0 } },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "reasoning" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "real-sig" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          },
        ]),
      );

      const { frames } = await drainFrames(
        provider.chatStream({
          model: "claude-sonnet-5",
          system: "sys",
          messages: [{ role: "user", content: "think" }],
        }),
      );

      expect(frames).toEqual([
        { type: "thinking_delta", thinking: "reasoning", signature: "real-sig" },
      ]);
    });

    it("captures the signature when the thinking text is empty (display: omitted)", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: { model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 0 } },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "sig-no-text" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          },
        ]),
      );

      const { frames } = await drainFrames(
        provider.chatStream({
          model: "claude-sonnet-5",
          system: "sys",
          messages: [{ role: "user", content: "think" }],
        }),
      );

      expect(frames).toEqual([{ type: "thinking_delta", thinking: "", signature: "sig-no-text" }]);
    });

    it("accumulates thinking in stream and emits as thinking_delta", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: {
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "sig-stream" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Step 1: " },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "analyze." },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "Answer" },
          },
          { type: "content_block_stop", index: 1 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 20 },
          },
        ]),
      );

      const { frames, meta } = await drainFrames(
        provider.chatStream({
          model: "claude-sonnet-4-6",
          system: "sys",
          messages: [{ role: "user", content: "think" }],
        }),
      );

      expect(frames).toEqual([
        { type: "thinking_delta", thinking: "Step 1: analyze.", signature: "sig-stream" },
        { type: "text_delta", text: "Answer" },
      ]);

      expect(meta.stopReason).toBe("end_turn");
    });
  });

  // Current models reject sampling parameters with a 400, and on the
  // degraded-reply path that failure is swallowed into the fixed fallback
  // string. `temperature` stays on ChatParams for the OpenAI-compatible
  // adapter, so this adapter is what has to strip it.
  describe("sampling parameters", () => {
    it("drops temperature instead of forwarding it", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok", citations: null }],
        stop_reason: "end_turn",
        model: "claude-sonnet-5",
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.chat({
        model: "claude-sonnet-5",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0,
      });

      expect(mockCreate.mock.calls[0]![0]).not.toHaveProperty("temperature");
    });

    it("drops temperature on the responseFormat path too", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "tu_1", name: "extract", input: { ok: true } }],
        stop_reason: "tool_use",
        model: "claude-sonnet-5",
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.chat({
        model: "claude-sonnet-5",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0,
        responseFormat: {
          type: "json_schema",
          name: "extract",
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      });

      expect(mockCreate.mock.calls[0]![0]).not.toHaveProperty("temperature");
    });

    it("warns once per model when it drops a temperature", async () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        const provider = createProvider();
        // Unique per run: the warn-once cache is module-level, so a model
        // id shared with another test would make this assertion depend on
        // file execution order.
        const model = `claude-test-warn-once-${Math.random()}`;
        for (let i = 0; i < 2; i++) {
          mockCreate.mockResolvedValueOnce({
            content: [{ type: "text", text: "ok", citations: null }],
            stop_reason: "end_turn",
            model,
            usage: { input_tokens: 10, output_tokens: 5 },
          });
          await provider.chat({
            model,
            system: "sys",
            messages: [{ role: "user", content: "hi" }],
            temperature: 0,
          });
        }

        const dropWarnings = warnSpy.mock.calls.filter(
          (call) => typeof call[1] === "string" && call[1].includes("dropping temperature"),
        );
        expect(dropWarnings).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("stays silent when no temperature was requested", async () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        const provider = createProvider();
        mockCreate.mockResolvedValueOnce({
          content: [{ type: "text", text: "ok", citations: null }],
          stop_reason: "end_turn",
          model: "claude-sonnet-5",
          usage: { input_tokens: 10, output_tokens: 5 },
        });

        await provider.chat({
          model: "claude-sonnet-5",
          system: "sys",
          messages: [{ role: "user", content: "hi" }],
        });

        const dropWarnings = warnSpy.mock.calls.filter(
          (call) => typeof call[1] === "string" && call[1].includes("dropping temperature"),
        );
        expect(dropWarnings).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // The SDK throws client-side, before any network call, for a
  // non-streaming request above 21_333 max_tokens. Callers pass the
  // model's full resolved maxOutputTokens — 64_000 on the 5 series.
  describe("non-streaming max_tokens ceiling", () => {
    it("clamps a caller's cap that would trip the SDK guard", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok", citations: null }],
        stop_reason: "end_turn",
        model: "claude-sonnet-5",
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.chat({
        model: "claude-sonnet-5",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 64_000,
      });

      expect(mockCreate.mock.calls[0]![0].max_tokens).toBe(21_333);
    });

    it("leaves a cap under the ceiling alone", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok", citations: null }],
        stop_reason: "end_turn",
        model: "claude-sonnet-5",
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.chat({
        model: "claude-sonnet-5",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 8192,
      });

      expect(mockCreate.mock.calls[0]![0].max_tokens).toBe(8192);
    });

    it("does not clamp the streaming path, which has no such limit", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: { model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 0 } },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          },
        ]),
      );

      await drainFrames(
        provider.chatStream({
          model: "claude-sonnet-5",
          system: "sys",
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 64_000,
        }),
      );

      expect(mockCreate.mock.calls[0]![0].max_tokens).toBe(64_000);
    });
  });

  describe("responseFormat", () => {
    const PersonSchema = z.object({ name: z.string().min(1), age: z.number() });

    const PERSON_FORMAT: ResponseFormat = {
      type: "json_schema",
      name: "extract_data",
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { name: { type: "string", minLength: 1 }, age: { type: "number" } },
        required: ["name", "age"],
        additionalProperties: false,
      },
    };

    /** A format whose `stageOutput` admits any keys, as `z.record` emits. */
    const OPEN_FORMAT: ResponseFormat = {
      type: "json_schema",
      name: "pipeline_definition",
      schema: {
        type: "object",
        properties: {
          stageOutput: {
            type: "object",
            propertyNames: { type: "string" },
            additionalProperties: {},
          },
        },
        required: ["stageOutput"],
        additionalProperties: false,
      },
    };

    function textReply(model: string, text: string) {
      return {
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text, citations: null },
        ],
        stop_reason: "end_turn",
        model,
        usage: { input_tokens: 50, output_tokens: 20 },
      };
    }

    function toolReply(model: string, name: string, input: unknown) {
      return {
        content: [{ type: "tool_use", id: "tu_1", name, input }],
        stop_reason: "tool_use",
        model,
        usage: { input_tokens: 50, output_tokens: 20 },
      };
    }

    function sentBody() {
      return expectDefined(mockCreate.mock.calls[0], "create call")[0];
    }

    it.each([
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ])("asks %s for structured output rather than forcing a tool", async (model) => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(textReply(model, '{"name":"Alice","age":30}'));

      const result = await provider.chat({
        model,
        system: "Extract structured data",
        messages: [{ role: "user", content: "Alice is 30" }],
        responseFormat: PERSON_FORMAT,
      });

      const body = sentBody();
      expect(body).not.toHaveProperty("tools");
      expect(body).not.toHaveProperty("tool_choice");
      expect(body.output_config).toEqual({
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              // The grammar takes no length bounds, so they move into
              // the description.
              name: { type: "string", description: "{minLength: 1}" },
              age: { type: "number" },
            },
            additionalProperties: false,
            required: ["name", "age"],
          },
        },
      });
      expect(body.system).toEqual([
        { type: "text", text: "Extract structured data", cache_control: { type: "ephemeral" } },
      ]);

      expect(result.stopReason).toBe("end_turn");
      expect(PersonSchema.parse(JSON.parse(extractText(result.content)))).toEqual({
        name: "Alice",
        age: 30,
      });
    });

    it("sends the grammar the correction schema's const and enum", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(textReply("claude-opus-5-5", '{"corrections":[]}'));

      await provider.chat({
        model: "claude-opus-5-5",
        system: "Extract corrections",
        messages: [{ role: "user", content: "transcript" }],
        responseFormat: {
          type: "json_schema",
          name: "correction-extraction",
          schema: toObjectJsonSchema(CorrectionExtractionSchema),
        },
      });

      const items = sentBody().output_config.format.schema.properties.corrections.items;
      expect(items).not.toHaveProperty("oneOf");
      expect(items).toMatchObject({
        anyOf: ["new", "reinforce", "contradiction"].map((action) => ({
          properties: {
            action: { type: "string", const: action },
            category: { type: "string", enum: ["style", "domain", "memory"] },
          },
          additionalProperties: false,
        })),
      });
    });

    it("offers an unforced tool named in the system prompt for a schema with an open object", async () => {
      const provider = createProvider();
      const input = { stageOutput: { title: { type: "string" } } };
      mockCreate.mockResolvedValueOnce(toolReply("claude-opus-5-5", "pipeline_definition", input));

      const result = await provider.chat({
        model: "claude-opus-5-5",
        system: "Compile the pipeline",
        messages: [{ role: "user", content: "Summarize the news as JSON" }],
        responseFormat: OPEN_FORMAT,
      });

      const body = sentBody();
      expect(body).not.toHaveProperty("output_config");
      expect(body).not.toHaveProperty("tool_choice");
      expect(body.tools).toEqual([
        {
          name: "pipeline_definition",
          description: "Respond with structured data matching the schema.",
          input_schema: {
            type: "object",
            properties: OPEN_FORMAT.schema.properties,
            required: ["stageOutput"],
          },
          cache_control: { type: "ephemeral" },
        },
      ]);
      expect(body.system).toEqual([
        { type: "text", text: "Compile the pipeline", cache_control: { type: "ephemeral" } },
        { type: "text", text: "Respond by calling the pipeline_definition tool." },
      ]);

      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(input) }]);
      expect(result.stopReason).toBe("end_turn");
    });

    it("offers the tool for a schema with an untyped node, which admits any value", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(toolReply("claude-opus-5-5", "payload", { data: [1] }));

      await provider.chat({
        model: "claude-opus-5-5",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        responseFormat: {
          type: "json_schema",
          name: "payload",
          schema: toObjectJsonSchema(z.object({ data: z.unknown() })),
        },
      });

      expect(sentBody()).not.toHaveProperty("output_config");
      expect(sentBody().tools).toHaveLength(1);
    });

    it("offers the tool, definitions included, for a recursive schema", async () => {
      const TreeNode = z.object({
        name: z.string(),
        get children() {
          return z.array(TreeNode);
        },
      });
      const schema = toObjectJsonSchema(z.object({ root: TreeNode }));
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        toolReply("claude-opus-5-5", "tree", { root: { name: "a", children: [] } }),
      );

      await provider.chat({
        model: "claude-opus-5-5",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        responseFormat: { type: "json_schema", name: "tree", schema },
      });

      expect(sentBody()).not.toHaveProperty("output_config");
      expect(expectDefined(sentBody().tools[0], "tool").input_schema).toEqual({
        type: "object",
        properties: schema.properties,
        required: ["root"],
        $defs: schema.$defs,
      });
    });

    it("offers the tool for a schema with a tuple", async () => {
      const schema = toObjectJsonSchema(z.object({ pair: z.tuple([z.string(), z.number()]) }));
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        toolReply("claude-opus-5-5", "point", { pair: ["east", 7] }),
      );

      const result = await provider.chat({
        model: "claude-opus-5-5",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        responseFormat: { type: "json_schema", name: "point", schema },
      });

      expect(sentBody()).not.toHaveProperty("output_config");
      expect(expectDefined(sentBody().tools[0], "tool").input_schema.properties).toEqual(
        schema.properties,
      );
      expect(extractText(result.content)).toBe('{"pair":["east",7]}');
    });

    it.each(["max_tokens", "refusal"])(
      "passes a tool-path reply's %s stop through",
      async (stopReason) => {
        const provider = createProvider();
        mockCreate.mockResolvedValueOnce({
          ...toolReply("claude-opus-5-5", "pipeline_definition", { stageOutput: {} }),
          stop_reason: stopReason,
        });

        const result = await provider.chat({
          model: "claude-opus-5-5",
          system: "Compile the pipeline",
          messages: [{ role: "user", content: "hi" }],
          responseFormat: OPEN_FORMAT,
        });

        expect(result.stopReason).toBe(stopReason);
      },
    );

    it("names the tool in a system prompt of its own when the caller sends none", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        toolReply("claude-opus-5-5", "pipeline_definition", { stageOutput: {} }),
      );

      await provider.chat({
        model: "claude-opus-5-5",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        responseFormat: OPEN_FORMAT,
      });

      expect(sentBody().system).toEqual([
        { type: "text", text: "Respond by calling the pipeline_definition tool." },
      ]);
    });

    it.each([
      ["JSON", '{"stageOutput":{}}'],
      ["prose", "Which feed should the pipeline read?"],
    ])(
      "throws for a tool-path reply of %s text that calls no tool, naming the tool to re-ask with",
      async (_kind, text) => {
        const provider = createProvider();
        mockCreate.mockResolvedValueOnce(textReply("claude-opus-5-5", text));

        const error = await provider
          .chat({
            model: "claude-opus-5-5",
            system: "Compile the pipeline",
            messages: [{ role: "user", content: "hi" }],
            responseFormat: OPEN_FORMAT,
          })
          .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(MissingToolCallError);
        expect(error).toMatchObject({
          reply: text,
          instruction: "Respond by calling the pipeline_definition tool.",
          usage: { inputTokens: 50, outputTokens: 20 },
        });
      },
    );

    it.each([
      ["max_tokens", "max_tokens"],
      ["refusal", "refusal"],
      ["model_context_window_exceeded", "context_overflow"],
    ])(
      "passes a tool-path reply stopped at %s before any call through",
      async (wire, canonical) => {
        const provider = createProvider();
        mockCreate.mockResolvedValueOnce({
          ...textReply("claude-opus-5-5", "Let me think"),
          stop_reason: wire,
        });

        const result = await provider.chat({
          model: "claude-opus-5-5",
          system: "Compile the pipeline",
          messages: [{ role: "user", content: "hi" }],
          responseFormat: OPEN_FORMAT,
        });

        expect(result.stopReason).toBe(canonical);
        expect(extractText(result.content)).toBe("Let me think");
      },
    );

    /** The body of an Anthropic API error. */
    function errorBody(type: string, message: string) {
      return { type: "error", error: { type, message }, request_id: "req_1" };
    }

    /** The SDK's error for a response, as the client raises it. */
    function apiError(status: number, type: string, message: string): Error {
      return APIError.generate(status, errorBody(type, message), undefined, new Headers());
    }

    it.each([
      ["documented", "Schema is too complex for compilation."],
      [
        "grammar-size",
        "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.",
      ],
      [
        "optional-parameter",
        "Schemas contains too many optional parameters (25), which would make grammar compilation inefficient. Reduce the number of optional parameters in your tool schemas (limit: 24).",
      ],
      [
        "union-parameter",
        "Schemas contains too many parameters with union types (17 parameters with type arrays or anyOf). This causes exponential compilation cost. Reduce the number of nullable or union-typed parameters (limit: 16 parameters with unions).",
      ],
      [
        "pattern",
        "output_config.format.schema: Unsupported regex feature in pattern field: pattern is too complex for structured output: reduce the {n,m} upper bound, narrow the character class range, or avoid nesting quantified groups",
      ],
    ])("retries once on the tool path past the grammar's %s limit", async (_limit, message) => {
      const provider = createProvider();
      mockCreate
        .mockRejectedValueOnce(apiError(400, "invalid_request_error", message))
        .mockResolvedValueOnce(
          toolReply("claude-opus-5-5", "extract_data", { name: "Alice", age: 30 }),
        );

      const result = await provider.chat({
        model: "claude-opus-5-5",
        system: "Extract structured data",
        messages: [{ role: "user", content: "Alice is 30" }],
        responseFormat: PERSON_FORMAT,
      });

      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(sentBody()).toHaveProperty("output_config");
      const retry = expectDefined(mockCreate.mock.calls[1], "retry")[0];
      expect(retry).not.toHaveProperty("output_config");
      expect(retry.tools).toEqual([expect.objectContaining({ name: "extract_data" })]);
      expect(result.content).toEqual([{ type: "text", text: '{"name":"Alice","age":30}' }]);
      expect(result.stopReason).toBe("end_turn");
    });

    it.each([
      [
        "another invalid request",
        apiError(
          400,
          "invalid_request_error",
          "output_config.format.schema: Invalid schema: Unsupported format 'regex'.",
        ),
      ],
      [
        "a limit's message on another error type",
        apiError(400, "api_error", "Schema is too complex for compilation."),
      ],
      [
        "a limit's message on another status",
        apiError(500, "invalid_request_error", "Schema is too complex for compilation."),
      ],
      ["an error without a body", new Error("Schema is too complex for compilation.")],
      [
        "a lookalike that isn't the SDK's error",
        Object.assign(new Error("400"), {
          status: 400,
          type: "invalid_request_error",
          error: errorBody("invalid_request_error", "Schema is too complex for compilation."),
        }),
      ],
    ])("surfaces %s without a retry", async (_label, error) => {
      const provider = createProvider();
      mockCreate.mockRejectedValueOnce(error);

      await expect(
        provider.chat({
          model: "claude-opus-5-5",
          system: "Extract structured data",
          messages: [{ role: "user", content: "Alice is 30" }],
          responseFormat: PERSON_FORMAT,
        }),
      ).rejects.toBe(error);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it("surfaces a tool-path request's compile error without a retry", async () => {
      const provider = createProvider();
      const error = apiError(
        400,
        "invalid_request_error",
        "Schema is too complex for compilation.",
      );
      mockCreate.mockRejectedValueOnce(error);

      await expect(
        provider.chat({
          model: "claude-opus-5-5",
          system: "Compile the pipeline",
          messages: [{ role: "user", content: "hi" }],
          responseFormat: OPEN_FORMAT,
        }),
      ).rejects.toBe(error);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it("surfaces the tool-path retry's own failure", async () => {
      const provider = createProvider();
      const retryError = apiError(529, "overloaded_error", "Overloaded");
      mockCreate
        .mockRejectedValueOnce(
          apiError(400, "invalid_request_error", "Schema is too complex for compilation."),
        )
        .mockRejectedValueOnce(retryError);

      await expect(
        provider.chat({
          model: "claude-opus-5-5",
          system: "Extract structured data",
          messages: [{ role: "user", content: "Alice is 30" }],
          responseFormat: PERSON_FORMAT,
        }),
      ).rejects.toBe(retryError);
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it("restores the capitalization of a structured-output reply's enum and const values", async () => {
      const provider = createProvider();
      const correction = {
        rule: "Be brief",
        category: "Style",
        reasoning: "The user asked twice",
        sourceMessage: 2,
        action: "New",
        matchedExistingRuleId: null,
        channelType: null,
      };
      mockCreate.mockResolvedValueOnce(
        textReply("claude-opus-5-5", JSON.stringify({ corrections: [correction] })),
      );

      const result = await provider.chat({
        model: "claude-opus-5-5",
        system: "Extract corrections",
        messages: [{ role: "user", content: "transcript" }],
        responseFormat: {
          type: "json_schema",
          name: "correction-extraction",
          schema: toObjectJsonSchema(CorrectionExtractionSchema),
        },
      });

      expect(result.content).toEqual([
        { type: "thinking", thinking: "", signature: "sig" },
        {
          type: "text",
          text: JSON.stringify({
            corrections: [{ ...correction, category: "style", action: "new" }],
          }),
        },
      ]);
    });

    it("logs a casing restore with the model and format name", async () => {
      const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
      try {
        const provider = createProvider();
        mockCreate.mockResolvedValueOnce(textReply("claude-opus-5-5", '{"value":"New"}'));

        await provider.chat({
          model: "claude-opus-5-5",
          system: "sys",
          messages: [{ role: "user", content: "hi" }],
          responseFormat: {
            type: "json_schema",
            name: "action",
            schema: toObjectJsonSchema(z.object({ value: z.literal("new") })),
          },
        });

        expect(debugSpy).toHaveBeenCalledWith(
          { model: "claude-opus-5-5", format: "action" },
          expect.stringContaining("restored the capitalization"),
        );
      } finally {
        debugSpy.mockRestore();
      }
    });

    it("passes a structured-output reply's text through, whatever it says", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(textReply("claude-opus-5-5", "Who is Alice?"));

      const result = await provider.chat({
        model: "claude-opus-5-5",
        system: "Extract structured data",
        messages: [{ role: "user", content: "Alice is 30" }],
        responseFormat: PERSON_FORMAT,
      });

      expect(extractText(result.content)).toBe("Who is Alice?");
      expect(result.stopReason).toBe("end_turn");
    });

    it("counts a structured-output request with its output format", async () => {
      const provider = createProvider();
      mockCountTokens.mockResolvedValueOnce({ input_tokens: 100 });

      await provider.countTokens({
        model: "claude-opus-5-5",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        responseFormat: PERSON_FORMAT,
      });

      const body = expectDefined(mockCountTokens.mock.calls[0], "countTokens call")[0];
      expect(body).not.toHaveProperty("tools");
      expect(body.output_config.format.type).toBe("json_schema");
    });

    it("throws when both responseFormat and tools are provided", async () => {
      const provider = createProvider();

      await expect(
        provider.chat({
          model: "claude-sonnet-4-6",
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

  describe("document blocks", () => {
    function setup() {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok", citations: null }],
        stop_reason: "end_turn",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      return provider;
    }

    it("translates a base64 PDF document", async () => {
      const provider = setup();
      await provider.chat({
        model: "claude-sonnet-4-6",
        system: "sys",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: "base64",
                data: "JVBERi0xLjQ=",
                mediaType: "application/pdf",
                name: "report.pdf",
              },
            ],
          },
        ],
      });

      const block = mockCreate.mock.calls[0]![0].messages[0].content[0];
      expect(block).toEqual({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQ=" },
        title: "report.pdf",
      });
    });

    it("translates a text/plain document via the text source variant", async () => {
      const provider = setup();
      await provider.chat({
        model: "claude-sonnet-4-6",
        system: "sys",
        messages: [
          {
            role: "user",
            content: [
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

      const block = mockCreate.mock.calls[0]![0].messages[0].content[0];
      expect(block).toEqual({
        type: "document",
        source: { type: "text", media_type: "text/plain", data: "hello world" },
        title: "notes.txt",
      });
    });

    // Text-like family: structured text MIME types are transcoded through
    // the text-source path (Anthropic only labels the wire `text/plain`,
    // but the original filename rides on `title` so the model knows
    // it's markdown/csv/json/etc.).
    it.each([
      ["text/markdown", "report.md", "# Hello"],
      ["text/csv", "data.csv", "a,b\n1,2"],
      ["text/html", "page.html", "<html></html>"],
      ["application/json", "data.json", '{"k":"v"}'],
      ["application/xml", "data.xml", "<r/>"],
      ["application/yaml", "config.yaml", "k: v"],
      ["application/x-yaml", "config.yml", "k: v"],
    ])(
      "transcodes %s as text source with original filename in title",
      async (mediaType, name, plain) => {
        const provider = setup();
        await provider.chat({
          model: "claude-sonnet-4-6",
          system: "sys",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  source: "base64",
                  data: Buffer.from(plain, "utf-8").toString("base64"),
                  mediaType,
                  name,
                },
              ],
            },
          ],
        });

        const block = mockCreate.mock.calls[0]![0].messages[0].content[0];
        expect(block).toEqual({
          type: "document",
          source: { type: "text", media_type: "text/plain", data: plain },
          title: name,
        });
      },
    );

    it("throws a clear error pre-flight on unsupported binary mediaType", async () => {
      const provider = setup();
      // application/zip is a real Telegram doc upload type Anthropic can't
      // ingest. Fail fast rather than burning a 400 round-trip.
      await expect(
        provider.chat({
          model: "claude-sonnet-4-6",
          system: "sys",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  source: "base64",
                  data: "UEsDBA==",
                  mediaType: "application/zip",
                  name: "archive.zip",
                },
              ],
            },
          ],
        }),
      ).rejects.toThrow(/unsupported mediaType "application\/zip"/);
      // Must not even attempt the API call.
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("throws on application/octet-stream (Telegram fallback for unknown types)", async () => {
      const provider = setup();
      await expect(
        provider.chat({
          model: "claude-sonnet-4-6",
          system: "sys",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  source: "base64",
                  data: "AAA=",
                  mediaType: "application/octet-stream",
                },
              ],
            },
          ],
        }),
      ).rejects.toThrow(/unsupported mediaType/);
    });

    it("translates a url-source document", async () => {
      const provider = setup();
      await provider.chat({
        model: "claude-sonnet-4-6",
        system: "sys",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: "url",
                data: "https://example.com/x.pdf",
                mediaType: "application/pdf",
              },
            ],
          },
        ],
      });

      const block = mockCreate.mock.calls[0]![0].messages[0].content[0];
      expect(block).toEqual({
        type: "document",
        source: { type: "url", url: "https://example.com/x.pdf" },
      });
      expect(block).not.toHaveProperty("title");
    });

    it("omits the title field when name is undefined", async () => {
      const provider = setup();
      await provider.chat({
        model: "claude-sonnet-4-6",
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
              },
            ],
          },
        ],
      });

      const block = mockCreate.mock.calls[0]![0].messages[0].content[0];
      expect(block).not.toHaveProperty("title");
    });
  });
});
