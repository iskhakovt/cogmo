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

  describe("prompt caching", () => {
    it("adds cache_control to system when promptCaching enabled", async () => {
      mockCreate.mockReset();
      const provider = new OpenAICompatibleProvider("openrouter", {
        apiKey: "key",
        baseURL: "http://test",
        promptCaching: true,
      });
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        model: "m",
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      });

      await provider.chat({
        model: "anthropic/claude-sonnet-4",
        system: "Be helpful",
        messages: [{ role: "user", content: "hi" }],
      });

      const args = mockCreate.mock.calls[0][0];
      expect(args.messages[0].content).toEqual([
        expect.objectContaining({
          type: "text",
          text: "Be helpful",
          cache_control: { type: "ephemeral" },
        }),
      ]);
    });

    it("sends plain system string when promptCaching disabled", async () => {
      const provider = createProvider(); // promptCaching defaults to false
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        model: "m",
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      });

      await provider.chat({
        model: "m",
        system: "Be helpful",
        messages: [{ role: "user", content: "hi" }],
      });

      const args = mockCreate.mock.calls[0][0];
      expect(args.messages[0].content).toBe("Be helpful");
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

      const args = mockCreate.mock.calls[0][0];
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

      const args = mockCreate.mock.calls[0][0];
      const assistantMsg = args.messages[1]; // [0] is system
      // Text extracted, thinking blocks filtered out
      expect(assistantMsg.content).toBe("visible answer");
      // No thinking content leaked into the message
      expect(JSON.stringify(assistantMsg)).not.toContain("internal reasoning");
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

      const args = mockCreate.mock.calls[0][0];
      const userMsg = args.messages[1];
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

      const args = mockCreate.mock.calls[0][0];
      const userMsg = args.messages[1];
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

      const args = mockCreate.mock.calls[0][0];
      const userMsg = args.messages[1];
      expect(userMsg.content).toBe(
        "[document: report.pdf — binary content not supported on this provider]",
      );
      // The base64 PDF bytes must NOT leak into the text payload.
      expect(JSON.stringify(userMsg)).not.toContain("JVBERi0");
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

      const args = mockCreate.mock.calls[0][0];
      const userMsg = args.messages[1];
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
