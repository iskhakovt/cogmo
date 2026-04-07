import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "./anthropic.js";
import type { StreamEvent } from "./types.js";

// Mock the Anthropic SDK — use a class so `new Anthropic()` works
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
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
  return new AnthropicProvider("test-key");
}

describe("AnthropicProvider", () => {
  it("maps a simple text response", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Hello!", citations: null }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 15, output_tokens: 8 },
    });

    const result = await provider.chat({
      model: "claude-sonnet-4-20250514",
      system: "Be helpful",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 8 });
  });

  it("maps a tool_use response", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "tool_use", id: "tu_123", name: "get_time", input: {}, caller: { type: "direct" } },
      ],
      stop_reason: "tool_use",
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 20, output_tokens: 12 },
    });

    const result = await provider.chat({
      model: "claude-sonnet-4-20250514",
      system: "sys",
      messages: [{ role: "user", content: "what time?" }],
    });

    expect(result.stopReason).toBe("tool_use");
    expect(result.content).toEqual([
      { type: "tool_use", id: "tu_123", name: "get_time", input: {} },
    ]);
  });

  it("skips unknown block types", async () => {
    const provider = createProvider();
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "thinking", thinking: "hmm..." },
        { type: "text", text: "answer", citations: null },
      ],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await provider.chat({
      model: "claude-sonnet-4-20250514",
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
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await provider.chat({
      model: "claude-sonnet-4-20250514",
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
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await provider.chat({
      model: "claude-sonnet-4-20250514",
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
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await provider.chat({
      model: "claude-sonnet-4-20250514",
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
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await provider.chat({
      model: "claude-sonnet-4-20250514",
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
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await provider.chat({
      model: "claude-sonnet-4-20250514",
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
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 10, output_tokens: 100 },
    });

    const result = await provider.chat({
      model: "claude-sonnet-4-20250514",
      system: "sys",
      messages: [{ role: "user", content: "write a novel" }],
    });

    expect(result.stopReason).toBe("max_tokens");
  });

  describe("chatStream", () => {
    const defaultParams = {
      model: "claude-sonnet-4-20250514",
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
              model: "claude-sonnet-4-20250514",
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
      expect(meta.model).toBe("claude-sonnet-4-20250514");
      expect(meta.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("accumulates tool input and yields tool_start on block stop", async () => {
      const provider = createProvider();
      mockCreate.mockResolvedValueOnce(
        mockStream([
          {
            type: "message_start",
            message: {
              model: "claude-sonnet-4-20250514",
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
              model: "claude-sonnet-4-20250514",
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
              model: "claude-sonnet-4-20250514",
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
  });
});
