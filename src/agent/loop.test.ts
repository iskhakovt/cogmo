import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LlmProvider } from "../llm/provider.js";
import type {
  ChatStreamResult,
  LlmResponse,
  Message,
  StopReason,
  StreamEvent,
} from "../llm/types.js";
import type { StepRunner } from "./loop.js";
import { clearOldThinking, runAgentLoop, runStreamingAgentLoop } from "./loop.js";
import type { Service } from "./service.js";
import { defineTool, ToolRegistry } from "./tools.js";

function stubService(): Service {
  return {
    memory: {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
      retain: vi.fn().mockResolvedValue(undefined),
      reflect: vi.fn().mockResolvedValue({ answer: "" }),
    },
    files: {
      read: vi.fn().mockResolvedValue(""),
      write: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    coreMemory: {
      get: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function mockProvider(responses: LlmResponse[]): LlmProvider {
  const chat = vi.fn();
  for (const r of responses) {
    chat.mockResolvedValueOnce(r);
  }
  return {
    name: "mock",
    chat,
    chatStream() {
      throw new Error("chatStream not implemented in mock");
    },
    countTokens: vi.fn(),
  };
}

function textResponse(text: string): LlmResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function toolUseResponse(toolName: string, toolId: string, input: unknown): LlmResponse {
  return {
    content: [{ type: "tool_use", id: toolId, name: toolName, input }],
    stopReason: "tool_use",
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

describe("runAgentLoop", () => {
  it("returns text on single-turn end_turn", async () => {
    const provider = mockProvider([textResponse("Hello!")]);
    const tools = new ToolRegistry();

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "Be helpful",
      messages: [{ role: "user", content: "Hi" }],
      tools,
      service: stubService(),
    });

    expect(result.text).toBe("Hello!");
    expect(result.iterations).toBe(1);
    expect(result.model).toBe("mock-model");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(provider.chat).toHaveBeenCalledOnce();
  });

  it("executes tool calls and continues", async () => {
    const provider = mockProvider([
      toolUseResponse("echo", "tool-1", { text: "ping" }),
      textResponse("Got: pong"),
    ]);

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "echo",
        description: "echoes",
        schema: z.object({ text: z.string() }),
        handler: async (input) => `pong from ${input.text}`,
      }),
    );

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "echo ping" }],
      tools,
      service: stubService(),
    });

    expect(result.text).toBe("Got: pong");
    expect(result.iterations).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });

    // Result messages: [user, assistant(tool_use), user(tool_result), assistant(text)]
    expect(result.messages).toHaveLength(4);
    expect(result.messages[2]!.role).toBe("user");
    expect(result.messages[2]!.content).toEqual([
      { type: "tool_result", toolUseId: "tool-1", content: "pong from ping" },
    ]);
  });

  it("handles unknown tool gracefully", async () => {
    const provider = mockProvider([
      toolUseResponse("nonexistent", "tool-1", {}),
      textResponse("Sorry, that tool doesn't exist"),
    ]);

    const tools = new ToolRegistry();

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "use magic" }],
      tools,
      service: stubService(),
    });

    expect(result.iterations).toBe(2);
    expect(result.messages[2]!.content).toEqual([
      {
        type: "tool_result",
        toolUseId: "tool-1",
        content: 'Error: unknown tool "nonexistent"',
        isError: true,
      },
    ]);
  });

  it("handles tool handler errors gracefully", async () => {
    const provider = mockProvider([
      toolUseResponse("fail_tool", "tool-1", {}),
      textResponse("Tool failed, sorry"),
    ]);

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "fail_tool",
        description: "always fails",
        schema: z.object({}),
        handler: async () => {
          throw new Error("boom");
        },
      }),
    );

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "fail" }],
      tools,
      service: stubService(),
    });

    expect(result.iterations).toBe(2);
    expect(result.messages[2]!.content).toEqual([
      { type: "tool_result", toolUseId: "tool-1", content: "Error: boom", isError: true },
    ]);
  });

  it("handles multiple simultaneous tool calls", async () => {
    const provider = mockProvider([
      {
        content: [
          { type: "tool_use", id: "t1", name: "a", input: {} },
          { type: "tool_use", id: "t2", name: "b", input: {} },
        ],
        stopReason: "tool_use",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      textResponse("Both done"),
    ]);

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "a",
        description: "a",
        schema: z.object({}),
        handler: async () => "result-a",
      }),
    );
    tools.register(
      defineTool({
        name: "b",
        description: "b",
        schema: z.object({}),
        handler: async () => "result-b",
      }),
    );

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "do both" }],
      tools,
      service: stubService(),
    });

    expect(result.text).toBe("Both done");
    expect(result.messages[2]!.content).toEqual([
      { type: "tool_result", toolUseId: "t1", content: "result-a" },
      { type: "tool_result", toolUseId: "t2", content: "result-b" },
    ]);
  });

  it("stops at maxIterations", async () => {
    // Provider always returns tool_use — loop should stop after 2 iterations
    const provider = mockProvider([
      toolUseResponse("echo", "t1", {}),
      toolUseResponse("echo", "t2", {}),
      toolUseResponse("echo", "t3", {}),
    ]);

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "echo",
        description: "echo",
        schema: z.object({}),
        handler: async () => "ok",
      }),
    );

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "loop" }],
      tools,
      service: stubService(),
      maxIterations: 2,
    });

    expect(result.iterations).toBe(2);
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  // Regression: model emits a tool_use block but reports stop_reason: end_turn
  // (or max_tokens, or anything other than tool_use). Before the fix the loop
  // returned at iteration 1 with the orphan persisted; tools were never run
  // and the next turn poisoned the message array on the API side. Drive flow
  // off content presence, not stop_reason.
  it("executes tool_use even when stop_reason is end_turn", async () => {
    const provider = mockProvider([
      {
        content: [{ type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } }],
        stopReason: "end_turn",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      textResponse("done"),
    ]);
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "echo",
        description: "echo",
        schema: z.object({ text: z.string() }),
        handler: async (input) => `pong from ${input.text}`,
      }),
    );

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "echo" }],
      tools,
      service: stubService(),
    });

    expect(result.iterations).toBe(2);
    // Pair-closing tool_result must follow the tool_use; no orphan tool_use
    // should be in newMessages without a matching tool_result.
    expect(result.newMessages).toHaveLength(3);
    expect(result.newMessages[0]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } }],
    });
    expect(result.newMessages[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: "pong from hi" }],
    });
  });

  it("executes tool_use even when stop_reason is max_tokens", async () => {
    const provider = mockProvider([
      {
        content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }],
        stopReason: "max_tokens",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      textResponse("done"),
    ]);
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "echo",
        description: "echo",
        schema: z.object({}),
        handler: async () => "ok",
      }),
    );

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "echo" }],
      tools,
      service: stubService(),
    });

    expect(result.iterations).toBe(2);
    expect(result.newMessages[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }],
    });
  });

  it("does not send tools param when registry is empty", async () => {
    const provider = mockProvider([textResponse("No tools here")]);
    const tools = new ToolRegistry();

    await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools,
      service: stubService(),
    });

    const callArgs = vi.mocked(provider.chat).mock.calls[0]![0];
    expect(callArgs.tools).toBeUndefined();
  });

  it("does not mutate the original messages array", async () => {
    const provider = mockProvider([textResponse("done")]);
    const tools = new ToolRegistry();
    const original = [{ role: "user" as const, content: "hi" }];

    await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: original,
      tools,
      service: stubService(),
    });

    expect(original).toHaveLength(1);
  });

  it("passes service to tool handler", async () => {
    let receivedService: Service | undefined;
    const svc = stubService();

    const provider = mockProvider([toolUseResponse("spy", "t1", {}), textResponse("done")]);

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "spy",
        description: "captures service",
        schema: z.object({}),
        handler: async (_input, service) => {
          receivedService = service;
          return "ok";
        },
      }),
    );

    await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "spy" }],
      tools,
      service: svc,
    });

    expect(receivedService).toBe(svc);
  });
});

// --- Streaming agent loop tests ---

interface MockStreamTurn {
  events: StreamEvent[];
  stopReason: StopReason;
}

function mockStreamProvider(turns: MockStreamTurn[]): LlmProvider {
  const chatStream = vi.fn();
  for (const turn of turns) {
    chatStream.mockReturnValueOnce({
      events: (async function* () {
        for (const e of turn.events) yield e;
      })(),
      response: Promise.resolve({
        stopReason: turn.stopReason,
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    } satisfies ChatStreamResult);
  }
  return {
    name: "mock-stream",
    chat: vi.fn(),
    chatStream,
    countTokens: vi.fn(),
  };
}

describe("runStreamingAgentLoop", () => {
  it("streams text and returns result", async () => {
    const provider = mockStreamProvider([
      {
        events: [
          { type: "text_delta", text: "Hello" },
          { type: "text_delta", text: " world" },
        ],
        stopReason: "end_turn",
      },
    ]);
    const tools = new ToolRegistry();
    const collected: StreamEvent[] = [];

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools,
      service: stubService(),
      onEvent: async (e) => {
        collected.push(e);
      },
    });

    expect(result.text).toBe("Hello world");
    expect(result.iterations).toBe(1);
    expect(collected).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
    ]);
  });

  it("handles tool use across turns", async () => {
    const provider = mockStreamProvider([
      {
        events: [
          { type: "text_delta", text: "Let me search." },
          { type: "tool_start", id: "t1", name: "echo", input: { text: "ping" } },
        ],
        stopReason: "tool_use",
      },
      {
        events: [{ type: "text_delta", text: "Got: pong" }],
        stopReason: "end_turn",
      },
    ]);

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "echo",
        description: "echoes",
        schema: z.object({ text: z.string() }),
        handler: async (input) => `pong from ${input.text}`,
      }),
    );

    const collected: StreamEvent[] = [];

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "echo ping" }],
      tools,
      service: stubService(),
      onEvent: async (e) => {
        collected.push(e);
      },
    });

    expect(result.text).toBe("Got: pong");
    expect(result.iterations).toBe(2);

    // Events: text_delta, tool_start, tool_result, text_delta
    const types = collected.map((e) => e.type);
    expect(types).toEqual(["text_delta", "tool_start", "tool_result", "text_delta"]);

    // tool_result should have the handler's output
    const toolResult = collected.find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({
      type: "tool_result",
      name: "echo",
      output: "pong from ping",
    });
  });

  it("emits onEvent for every event in order", async () => {
    const provider = mockStreamProvider([
      {
        events: [
          { type: "text_delta", text: "A" },
          { type: "text_delta", text: "B" },
          { type: "text_delta", text: "C" },
        ],
        stopReason: "end_turn",
      },
    ]);
    const tools = new ToolRegistry();
    const order: string[] = [];

    await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools,
      service: stubService(),
      onEvent: async (e) => {
        if (e.type === "text_delta") order.push(e.text);
      },
    });

    expect(order).toEqual(["A", "B", "C"]);
  });

  it("does not mutate the original messages array", async () => {
    const provider = mockStreamProvider([
      { events: [{ type: "text_delta", text: "done" }], stopReason: "end_turn" },
    ]);
    const tools = new ToolRegistry();
    const original = [{ role: "user" as const, content: "hi" }];

    await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: original,
      tools,
      service: stubService(),
      onEvent: async () => {},
    });

    expect(original).toHaveLength(1);
  });

  it("respects maxIterations", async () => {
    const provider = mockStreamProvider([
      {
        events: [{ type: "tool_start", id: "t1", name: "echo", input: {} }],
        stopReason: "tool_use",
      },
      {
        events: [{ type: "tool_start", id: "t2", name: "echo", input: {} }],
        stopReason: "tool_use",
      },
      {
        events: [{ type: "tool_start", id: "t3", name: "echo", input: {} }],
        stopReason: "tool_use",
      },
    ]);

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "echo",
        description: "echo",
        schema: z.object({}),
        handler: async () => "ok",
      }),
    );

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "loop" }],
      tools,
      service: stubService(),
      maxIterations: 2,
      onEvent: async () => {},
    });

    expect(result.iterations).toBe(2);
    expect(provider.chatStream).toHaveBeenCalledTimes(2);
  });

  // Regression: streamed tool_use accompanied by stop_reason: end_turn.
  // Same orphan-persistence bug as runAgentLoop, but in the production hot
  // path (handle-message uses runStreamingAgentLoop). Before the fix the loop
  // appended an assistant message containing only tool_use and returned;
  // handle-message then persisted that orphan to the messages table.
  it("executes tool_use even when stream reports stop_reason: end_turn", async () => {
    const provider = mockStreamProvider([
      {
        events: [{ type: "tool_start", id: "t1", name: "echo", input: { text: "hi" } }],
        stopReason: "end_turn",
      },
      { events: [{ type: "text_delta", text: "done" }], stopReason: "end_turn" },
    ]);
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "echo",
        description: "echo",
        schema: z.object({ text: z.string() }),
        handler: async (input) => `pong from ${input.text}`,
      }),
    );

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "echo" }],
      tools,
      service: stubService(),
      onEvent: async () => {},
    });

    expect(result.iterations).toBe(2);
    // Assistant tool_use must be paired with the user tool_result before the
    // final assistant text — no orphan can land in newMessages.
    expect(result.newMessages).toHaveLength(3);
    expect(result.newMessages[0]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } }],
    });
    expect(result.newMessages[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: "pong from hi" }],
    });
  });

  it("captures thinking_delta into content blocks but does not forward to onEvent", async () => {
    const provider = mockStreamProvider([
      {
        events: [
          { type: "thinking_delta", thinking: "Let me think...", signature: "sig" },
          { type: "text_delta", text: "Answer" },
        ],
        stopReason: "end_turn",
      },
    ]);
    const tools = new ToolRegistry();
    const collected: StreamEvent[] = [];

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "think" }],
      tools,
      service: stubService(),
      onEvent: async (e) => {
        collected.push(e);
      },
    });

    // thinking_delta NOT forwarded to onEvent
    expect(collected).toEqual([{ type: "text_delta", text: "Answer" }]);

    // But thinking block IS in the message content
    const lastAssistant = result.messages[result.messages.length - 1]!;
    expect(lastAssistant.content).toEqual([
      { type: "thinking", thinking: "Let me think...", signature: "sig" },
      { type: "text", text: "Answer" },
    ]);
  });
});

describe("tool durability (stepRun)", () => {
  it("wraps a durable tool in stepRun with a deterministic step id", async () => {
    const provider = mockProvider([
      toolUseResponse("paid", "toolu_01ABC", { q: "hi" }),
      textResponse("done"),
    ]);

    let handlerCalls = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "paid",
      description: "expensive",
      inputSchema: { type: "object" },
      durable: true,
      handler: async () => {
        handlerCalls++;
        return "paid-result";
      },
    });

    const stepRunCalls: Array<{ id: string }> = [];
    const stepRun: StepRunner = async (id, fn) => {
      stepRunCalls.push({ id });
      return fn();
    };

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools,
      service: stubService(),
      stepRun,
    });

    expect(stepRunCalls).toEqual([{ id: "tool-paid-toolu_01ABC" }]);
    expect(handlerCalls).toBe(1);
    // Handler ran *inside* the wrapper — its output flows through as tool_result.
    expect(result.messages[2]!.content).toEqual([
      { type: "tool_result", toolUseId: "toolu_01ABC", content: "paid-result" },
    ]);
  });

  it("runs a durable tool directly when no stepRun is provided", async () => {
    const provider = mockProvider([toolUseResponse("paid", "toolu_02", {}), textResponse("done")]);

    let handlerCalls = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "paid",
      description: "expensive",
      inputSchema: { type: "object" },
      durable: true,
      handler: async () => {
        handlerCalls++;
        return "paid-result";
      },
    });

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools,
      service: stubService(),
      // no stepRun
    });

    expect(handlerCalls).toBe(1);
    expect(result.messages[2]!.content).toEqual([
      { type: "tool_result", toolUseId: "toolu_02", content: "paid-result" },
    ]);
  });

  it("does not invoke stepRun for non-durable tools", async () => {
    const provider = mockProvider([toolUseResponse("cheap", "toolu_03", {}), textResponse("done")]);

    const tools = new ToolRegistry();
    tools.register({
      name: "cheap",
      description: "free",
      inputSchema: { type: "object" },
      // durable omitted — defaults to not durable
      handler: async () => "cheap-result",
    });

    const stepRun = vi.fn<StepRunner>(async (_id, fn) => fn());

    await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools,
      service: stubService(),
      stepRun,
    });

    expect(stepRun).not.toHaveBeenCalled();
  });

  it("uses distinct step ids when the same durable tool is called twice", async () => {
    const provider = mockProvider([
      {
        content: [
          { type: "tool_use", id: "toolu_A", name: "paid", input: {} },
          { type: "tool_use", id: "toolu_B", name: "paid", input: {} },
        ],
        stopReason: "tool_use",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      textResponse("done"),
    ]);

    const tools = new ToolRegistry();
    tools.register({
      name: "paid",
      description: "expensive",
      inputSchema: { type: "object" },
      durable: true,
      handler: async () => "ok",
    });

    const ids: string[] = [];
    const stepRun: StepRunner = async (id, fn) => {
      ids.push(id);
      return fn();
    };

    await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools,
      service: stubService(),
      stepRun,
    });

    expect(ids).toEqual(["tool-paid-toolu_A", "tool-paid-toolu_B"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("applies durability in the streaming loop as well", async () => {
    const provider = mockStreamProvider([
      {
        events: [{ type: "tool_start", id: "toolu_stream", name: "paid", input: {} }],
        stopReason: "tool_use",
      },
      { events: [{ type: "text_delta", text: "done" }], stopReason: "end_turn" },
    ]);

    const tools = new ToolRegistry();
    tools.register({
      name: "paid",
      description: "expensive",
      inputSchema: { type: "object" },
      durable: true,
      handler: async () => "stream-result",
    });

    const stepRunCalls: string[] = [];
    const stepRun: StepRunner = async (id, fn) => {
      stepRunCalls.push(id);
      return fn();
    };

    await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools,
      service: stubService(),
      onEvent: async () => {},
      stepRun,
    });

    expect(stepRunCalls).toEqual(["tool-paid-toolu_stream"]);
  });
});

describe("clearOldThinking", () => {
  it("clears thinking content in older assistant messages", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old reasoning", signature: "sig1" },
          { type: "text", text: "old answer" },
        ],
      },
      { role: "user", content: "follow up" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "current reasoning", signature: "sig2" },
          { type: "text", text: "current answer" },
        ],
      },
    ];

    const result = clearOldThinking(messages);

    // First assistant: thinking cleared, signature preserved
    expect(result[0]!.content).toEqual([
      { type: "thinking", thinking: "", signature: "sig1" },
      { type: "text", text: "old answer" },
    ]);

    // Last assistant: thinking preserved
    expect(result[2]!.content).toEqual([
      { type: "thinking", thinking: "current reasoning", signature: "sig2" },
      { type: "text", text: "current answer" },
    ]);
  });

  it("returns messages unchanged when no thinking blocks exist", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];

    const result = clearOldThinking(messages);
    expect(result).toEqual(messages);
  });

  it("handles string content messages", () => {
    const messages: Message[] = [
      { role: "assistant", content: "plain text" },
      { role: "user", content: "follow up" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning", signature: "sig" },
          { type: "text", text: "answer" },
        ],
      },
    ];

    const result = clearOldThinking(messages);
    // String content passes through unchanged
    expect(result[0]!.content).toBe("plain text");
    // Last assistant preserved
    expect(result[2]!.content).toEqual([
      { type: "thinking", thinking: "reasoning", signature: "sig" },
      { type: "text", text: "answer" },
    ]);
  });

  it("does not mutate original messages", () => {
    const original: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old", signature: "sig" },
          { type: "text", text: "answer" },
        ],
      },
      { role: "user", content: "next" },
      { role: "assistant", content: [{ type: "text", text: "latest" }] },
    ];

    clearOldThinking(original);

    // Original thinking content unchanged
    const blocks = original[0]!.content as Array<{ type: string; thinking?: string }>;
    expect(blocks[0]!.thinking).toBe("old");
  });
});
