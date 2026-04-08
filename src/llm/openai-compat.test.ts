import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "./openai-compat.js";
import type { StreamEvent } from "./types.js";

const mockCreate = vi.fn();
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockCreate } };
    },
  };
});

function createProvider(): OpenAICompatibleProvider {
  mockCreate.mockReset();
  return new OpenAICompatibleProvider("test", {
    apiKey: "test-key",
    baseURL: "http://test",
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

      const args = mockCreate.mock.calls[0][0];
      expect(args.messages[0]).toEqual({ role: "system", content: "Be concise" });
      expect(args.messages[1]).toEqual({ role: "user", content: "hi" });
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

      const args = mockCreate.mock.calls[0][0];
      // System + assistant + tool + (no text user msg)
      expect(args.messages).toHaveLength(3);
      expect(args.messages[2]).toEqual({
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

      const args = mockCreate.mock.calls[0][0];
      expect(args.tools[0]).toEqual({
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

      const args = mockCreate.mock.calls[0][0];
      expect(args.stream).toBe(true);
    });
  });
});
