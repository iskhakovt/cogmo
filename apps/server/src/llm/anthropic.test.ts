import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "./anthropic.js";
import { ProviderProtocolError } from "./errors.js";
import type { StreamEvent } from "./types.js";

// Mock the Anthropic SDK — use a class so `new Anthropic()` works
const mockCreate = vi.fn();
const mockCountTokens = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate, countTokens: mockCountTokens };
    },
  };
});

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

  it("maps model_context_window_exceeded to max_tokens, never end_turn", async () => {
    // Context overflow terminates the turn with no content. Folding it into
    // `end_turn` would match `classifyPostStream`'s empty-`end_turn` arm and
    // earn a continuation prompt — more tokens appended to a context that
    // just overflowed, guaranteeing the same failure on the retry and burning
    // the empty_end_turn budget on the way to the wrong degrade subtype.
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

    expect(result.stopReason).toBe("max_tokens");
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

    const { events, response } = provider.chatStream({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user", content: "a very long conversation" }],
    });
    for await (const _ of events) {
      /* drain */
    }

    const meta = await response;
    expect(meta.stopReason).toBe("max_tokens");
  });

  it.each([
    ["stop_sequence", "end_turn"],
    ["pause_turn", "end_turn"],
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

    const { events, response } = provider.chatStream({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user", content: "do something disallowed" }],
    });
    for await (const _ of events) {
      /* drain */
    }

    const meta = await response;
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

      const { events, response } = provider.chatStream(defaultParams);
      const collected: StreamEvent[] = [];
      for await (const event of events) {
        collected.push(event);
      }

      expect(collected).toEqual([
        { type: "text_delta", text: "Hello" },
        { type: "text_delta", text: " world" },
      ]);

      const meta = await response;
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
      const { events, response } = provider.chatStream(defaultParams);
      const collected: StreamEvent[] = [];
      for await (const event of events) {
        collected.push(event);
      }
      expect(collected).toEqual([
        { type: "tool_start", id: "tu_zero", name: "btc_spot", input: {} },
      ]);
      const meta = await response;
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

      const { events, response } = provider.chatStream(defaultParams);
      const collected: StreamEvent[] = [];
      for await (const event of events) {
        collected.push(event);
      }

      expect(collected).toEqual([
        { type: "tool_start", id: "tu_1", name: "web_search", input: { query: "weather" } },
      ]);

      const meta = await response;
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

      const { events } = provider.chatStream(defaultParams);
      const types: string[] = [];
      for await (const event of events) {
        types.push(event.type);
      }

      expect(types).toEqual(["text_delta", "tool_start"]);
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

      const { events } = provider.chatStream(defaultParams);
      // Drain the iterator
      for await (const _ of events) {
        /* noop */
      }

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

      const { events, response } = provider.chatStream(defaultParams);
      const collected: StreamEvent[] = [];
      for await (const event of events) collected.push(event);

      expect(collected).toEqual([
        { type: "tool_start", id: "tu_1", name: "web_search", input: { query: "weather" } },
      ]);
      await expect(response).resolves.toMatchObject({ stopReason: "tool_use" });
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

      const { events, response } = provider.chatStream(defaultParams);
      const collect = async (): Promise<StreamEvent[]> => {
        const out: StreamEvent[] = [];
        for await (const event of events) out.push(event);
        return out;
      };

      await expect(collect()).rejects.toBeInstanceOf(ProviderProtocolError);
      // Avoid an unhandled rejection from the parallel response promise.
      await expect(response).rejects.toBeInstanceOf(ProviderProtocolError);
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

  describe("thinking", () => {
    it("passes thinking config to the API", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: "thinking", thinking: "Let me reason...", signature: "sig" },
          { type: "text", text: "answer", citations: null },
        ],
        stop_reason: "end_turn",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 50, output_tokens: 30 },
      });

      await provider.chat({
        model: "claude-sonnet-4-6",
        system: "sys",
        messages: [{ role: "user", content: "think hard" }],
        thinking: { budgetTokens: 10000 },
      });

      const callArgs = mockCreate.mock.calls[0]![0];
      expect(callArgs.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
      // max_tokens = budgetTokens + default (8192)
      expect(callArgs.max_tokens).toBe(10000 + 8192);
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

      const { events, response } = provider.chatStream({
        model: "claude-sonnet-4-6",
        system: "sys",
        messages: [{ role: "user", content: "think" }],
        thinking: { budgetTokens: 5000 },
      });

      const collected: StreamEvent[] = [];
      for await (const event of events) collected.push(event);

      expect(collected).toEqual([
        { type: "thinking_delta", thinking: "Step 1: analyze.", signature: "sig-stream" },
        { type: "text_delta", text: "Answer" },
      ]);

      const meta = await response;
      expect(meta.stopReason).toBe("end_turn");
    });
  });

  describe("responseFormat", () => {
    it("converts responseFormat to tool_use trick", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "extract_data",
            input: { name: "Alice", age: 30 },
          },
        ],
        stop_reason: "tool_use",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 50, output_tokens: 20 },
      });

      const result = await provider.chat({
        model: "claude-sonnet-4-6",
        system: "Extract structured data",
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

      // Response normalized to TextBlock with JSON
      expect(result.content).toEqual([{ type: "text", text: '{"name":"Alice","age":30}' }]);
      expect(result.stopReason).toBe("end_turn");

      // Verify synthetic tool + tool_choice sent to API
      const callArgs = mockCreate.mock.calls[0]![0];
      expect(callArgs.tools).toHaveLength(1);
      expect(callArgs.tools[0].name).toBe("extract_data");
      expect(callArgs.tool_choice).toEqual({ type: "tool", name: "extract_data" });
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
