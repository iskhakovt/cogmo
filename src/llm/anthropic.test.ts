import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "./anthropic.js";
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

      const callArgs = mockCountTokens.mock.calls[0][0];
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
