import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import { ProviderProtocolError } from "../llm/errors.js";
import { RefusalError } from "../llm/fallback.js";
import type { LlmProvider } from "../llm/provider.js";
import type {
  ChatStreamResult,
  ContentBlock,
  LlmResponse,
  Message,
  StopReason,
  StreamEvent,
} from "../llm/types.js";
import { logger } from "../logger.js";
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
      stageRetain: vi.fn().mockResolvedValue(undefined),
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

  // --- Parallel tool fan-out ---
  //
  // Barrier-style handlers prove real concurrency: each handler waits on a
  // shared promise that only resolves after N peers have started, so
  // sequential execution would deadlock.
  it("fans out parallelSafe tools concurrently", async () => {
    const provider = mockProvider([
      {
        content: [
          { type: "tool_use", id: "t1", name: "gen", input: { n: 1 } },
          { type: "tool_use", id: "t2", name: "gen", input: { n: 2 } },
          { type: "tool_use", id: "t3", name: "gen", input: { n: 3 } },
        ],
        stopReason: "tool_use",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      textResponse("Three done"),
    ]);

    let started = 0;
    let releaseStartBarrier!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      releaseStartBarrier = resolve;
    });

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "gen",
        description: "gen",
        schema: z.object({ n: z.number() }),
        parallelSafe: true,
        handler: async (input) => {
          started++;
          if (started === 3) releaseStartBarrier();
          await allStarted;
          return `out-${input.n}`;
        },
      }),
    );

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "gen three" }],
      tools,
      service: stubService(),
    });

    expect(result.messages[2]!.content).toEqual([
      { type: "tool_result", toolUseId: "t1", content: "out-1" },
      { type: "tool_result", toolUseId: "t2", content: "out-2" },
      { type: "tool_result", toolUseId: "t3", content: "out-3" },
    ]);
  });

  // [safe, safe, unsafe, safe, safe] → fan out → unsafe → fan out.
  it("coalesces consecutive parallelSafe runs around unsafe entries", async () => {
    const provider = mockProvider([
      {
        content: [
          { type: "tool_use", id: "s1", name: "safe", input: { n: 1 } },
          { type: "tool_use", id: "s2", name: "safe", input: { n: 2 } },
          { type: "tool_use", id: "u", name: "unsafe", input: {} },
          { type: "tool_use", id: "s3", name: "safe", input: { n: 3 } },
          { type: "tool_use", id: "s4", name: "safe", input: { n: 4 } },
        ],
        stopReason: "tool_use",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      textResponse("Done"),
    ]);

    function makeBarrier(expected: number): {
      enter: () => Promise<void>;
    } {
      let started = 0;
      let release!: () => void;
      const ready = new Promise<void>((r) => {
        release = r;
      });
      return {
        enter: async () => {
          started++;
          if (started === expected) release();
          await ready;
        },
      };
    }
    const groupA = makeBarrier(2);
    const groupB = makeBarrier(2);
    const order: string[] = [];

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "safe",
        description: "safe",
        schema: z.object({ n: z.number() }),
        parallelSafe: true,
        handler: async (input) => {
          const barrier = input.n <= 2 ? groupA : groupB;
          await barrier.enter();
          order.push(`safe-${input.n}`);
          return `out-${input.n}`;
        },
      }),
    );
    tools.register(
      defineTool({
        name: "unsafe",
        description: "unsafe",
        schema: z.object({}),
        handler: async () => {
          order.push("unsafe");
          return "u";
        },
      }),
    );

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "mixed" }],
      tools,
      service: stubService(),
    });

    expect(result.messages[2]!.content).toEqual([
      { type: "tool_result", toolUseId: "s1", content: "out-1" },
      { type: "tool_result", toolUseId: "s2", content: "out-2" },
      { type: "tool_result", toolUseId: "u", content: "u" },
      { type: "tool_result", toolUseId: "s3", content: "out-3" },
      { type: "tool_result", toolUseId: "s4", content: "out-4" },
    ]);
    const unsafeIdx = order.indexOf("unsafe");
    expect(unsafeIdx).toBe(2);
    expect(new Set(order.slice(0, 2))).toEqual(new Set(["safe-1", "safe-2"]));
    expect(new Set(order.slice(3))).toEqual(new Set(["safe-3", "safe-4"]));
  });

  it("runs back-to-back unsafe tools strictly sequentially", async () => {
    const provider = mockProvider([
      {
        content: [
          { type: "tool_use", id: "u1", name: "step", input: { tag: "first" } },
          { type: "tool_use", id: "u2", name: "step", input: { tag: "second" } },
        ],
        stopReason: "tool_use",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      textResponse("done"),
    ]);

    let active = 0;
    let maxConcurrent = 0;
    const order: string[] = [];
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "step",
        description: "side-effecting step",
        schema: z.object({ tag: z.string() }),
        handler: async (input) => {
          active++;
          maxConcurrent = Math.max(maxConcurrent, active);
          await new Promise((r) => setTimeout(r, 5));
          order.push(input.tag);
          active--;
          return `done-${input.tag}`;
        },
      }),
    );

    await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "two writes" }],
      tools,
      service: stubService(),
    });

    expect(maxConcurrent).toBe(1);
    expect(order).toEqual(["first", "second"]);
  });

  // [safe, unknown, safe] with a 2-barrier on the safes. Coalescing requires
  // treating unknown tools as parallelSafe; if unknown were treated as unsafe
  // the groups would be [[safe], [unknown], [safe]] — each safe alone — and
  // the barrier would never release.
  it("coalesces unknown tools with adjacent parallelSafe entries", async () => {
    const provider = mockProvider([
      {
        content: [
          { type: "tool_use", id: "s1", name: "safe", input: {} },
          { type: "tool_use", id: "x1", name: "ghost", input: {} },
          { type: "tool_use", id: "s2", name: "safe", input: {} },
        ],
        stopReason: "tool_use",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      textResponse("done"),
    ]);

    let started = 0;
    let releaseBarrier!: () => void;
    const ready = new Promise<void>((r) => {
      releaseBarrier = r;
    });

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "safe",
        description: "safe",
        schema: z.object({}),
        parallelSafe: true,
        handler: async () => {
          started++;
          if (started === 2) releaseBarrier();
          await ready;
          return "ok";
        },
      }),
    );

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "safe + ghost + safe" }],
      tools,
      service: stubService(),
    });

    expect(result.messages[2]!.content).toEqual([
      { type: "tool_result", toolUseId: "s1", content: "ok" },
      {
        type: "tool_result",
        toolUseId: "x1",
        content: 'Error: unknown tool "ghost"',
        isError: true,
      },
      { type: "tool_result", toolUseId: "s2", content: "ok" },
    ]);
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

  // Regression: streamed tool_use accompanied by stop_reason: max_tokens.
  // Mirror of the end_turn case below — both must execute the tool, since
  // production saw end_turn but max_tokens is a structurally identical
  // failure mode (model truncated mid-thought after emitting a tool_use).
  it("executes tool_use even when stream reports stop_reason: max_tokens", async () => {
    const provider = mockStreamProvider([
      {
        events: [{ type: "tool_start", id: "t1", name: "echo", input: {} }],
        stopReason: "max_tokens",
      },
      { events: [{ type: "text_delta", text: "done" }], stopReason: "end_turn" },
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
      messages: [{ role: "user", content: "echo" }],
      tools,
      service: stubService(),
      onEvent: async () => {},
    });

    expect(result.iterations).toBe(2);
    expect(result.newMessages[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }],
    });
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

  it("propagates a mid-stream provider error without leaking an unhandledRejection", async () => {
    // The streaming adapters reject both the events iterator AND their
    // `response` promise on a stream-level failure. The loop awaits
    // `response` only on success, so without an upfront `.catch()` the
    // dangling rejection would crash the Node process under
    // `--unhandled-rejections=throw` (Node ≥ 15 default).
    const failure = new Error("upstream 502");
    (failure as Error & { status?: number }).status = 502;

    const provider: LlmProvider = {
      name: "leaky-stream",
      chat: vi.fn(),
      countTokens: vi.fn(),
      chatStream() {
        const events: AsyncIterable<StreamEvent> = {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<StreamEvent>> {
                throw failure;
              },
            };
          },
        };
        // Bare rejected promise — no pre-attached `.catch`. The loop must
        // attach one itself; if it doesn't, vitest reports an unhandled
        // rejection and the test fails.
        return { events, response: Promise.reject(failure) };
      },
    };

    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      await expect(
        runStreamingAgentLoop({
          provider,
          model: "test",
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
          tools: new ToolRegistry(),
          service: stubService(),
          onEvent: async () => {},
        }),
      ).rejects.toBe(failure);

      // Flush microtasks + macrotasks so any pending `unhandledRejection`
      // signal has fired before we assert.
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
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

// Pre-flight history sanitization runs validateHistory and emits a
// warn-level repair log when the validator returns repairs. A user message
// with a tool_result whose toolUseId has no matching prior tool_use is the
// minimal repro — `validateHistory` flags it as `dropped_stray_tool_result`,
// which routes through the `agent loop history invariants repaired` warn
// emission. Both tests below exercise that path: one with an injected
// `turnLogger`, one without to confirm fallback to the module-level
// `logger`.
describe("turnLogger plumbing", () => {
  function historyWithStrayToolResult(): Message[] {
    return [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "ghost", content: "stray" },
          { type: "text", text: "real text" },
        ],
      },
    ];
  }

  it("routes the history-repair warn through turnLogger when provided", async () => {
    const provider = mockStreamProvider([
      { events: [{ type: "text_delta", text: "ok" }], stopReason: "end_turn" },
    ]);
    const turnLogger = mock<Logger>();
    const fallbackSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    try {
      await runStreamingAgentLoop({
        provider,
        model: "test",
        systemPrompt: "sys",
        messages: historyWithStrayToolResult(),
        tools: new ToolRegistry(),
        service: stubService(),
        onEvent: async () => {},
        turnLogger,
      });

      expect(turnLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ repairCount: expect.any(Number) }),
        "agent loop history invariants repaired",
      );
      // Module-level logger must not see the repair warn — that's the whole
      // point of the child-logger plumbing.
      expect(fallbackSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        "agent loop history invariants repaired",
      );
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("falls back to the module-level logger when no turnLogger is provided", async () => {
    const provider = mockStreamProvider([
      { events: [{ type: "text_delta", text: "ok" }], stopReason: "end_turn" },
    ]);
    const fallbackSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    try {
      await runStreamingAgentLoop({
        provider,
        model: "test",
        systemPrompt: "sys",
        messages: historyWithStrayToolResult(),
        tools: new ToolRegistry(),
        service: stubService(),
        onEvent: async () => {},
      });

      expect(fallbackSpy).toHaveBeenCalledWith(
        expect.objectContaining({ repairCount: expect.any(Number) }),
        "agent loop history invariants repaired",
      );
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("routes the history-repair warn through turnLogger in runAgentLoop too", async () => {
    const provider = mockProvider([textResponse("ok")]);
    const turnLogger = mock<Logger>();

    await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: historyWithStrayToolResult(),
      tools: new ToolRegistry(),
      service: stubService(),
      turnLogger,
    });

    expect(turnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ repairCount: expect.any(Number) }),
      "agent loop history invariants repaired",
    );
  });

  // Force the iteration-limit branch: provider always returns a tool_use block
  // (so the loop never exits via end_turn) and `maxIterations: 1` trips the
  // ceiling immediately after the first round of tool execution.
  it("routes the iteration-limit warn through turnLogger", async () => {
    const provider = mockProvider([toolUseResponse("echo", "t1", {})]);
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "echo",
        description: "echo",
        schema: z.object({}),
        handler: async () => "ok",
      }),
    );
    const turnLogger = mock<Logger>();

    await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "loop" }],
      tools,
      service: stubService(),
      maxIterations: 1,
      turnLogger,
    });

    expect(turnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ maxIterations: 1 }),
      "agent loop hit iteration limit",
    );
  });
});

// --- Class C in-loop repair ---
//
// Each iteration's stream produces (events, response) — repair-test
// scenarios need both the stream content and the post-stream `stopReason`
// the classifier reads, plus the option to make a stream throw before
// completion. `repairStreamProvider` exposes that surface as a small
// builder so tests stay declarative.

type RepairTurn =
  | { kind: "stream"; events: StreamEvent[]; stopReason: StopReason }
  | { kind: "throw"; error: unknown };

function repairStreamProvider(turns: ReadonlyArray<RepairTurn>): {
  provider: LlmProvider;
  chatCalls: Array<Parameters<LlmProvider["chat"]>[0]>;
  streamCalls: Array<Parameters<LlmProvider["chatStream"]>[0]>;
} {
  const chatCalls: Array<Parameters<LlmProvider["chat"]>[0]> = [];
  const streamCalls: Array<Parameters<LlmProvider["chatStream"]>[0]> = [];
  let cursor = 0;
  const chatStream = vi.fn((params: Parameters<LlmProvider["chatStream"]>[0]) => {
    // Snapshot messages at call time — the loop holds a single mutable
    // array reference and mutates it across iterations; without the
    // structuredClone, assertions on streamCalls[i].messages see the
    // FINAL state, not the per-iteration state.
    streamCalls.push({ ...params, messages: structuredClone(params.messages) });
    const turn = turns[cursor++];
    if (!turn) throw new Error(`repairStreamProvider: ran out of turns (cursor=${cursor})`);
    if (turn.kind === "throw") {
      const err = turn.error;
      // Generator throws on first `next()` instead of yielding — symmetric
      // with the success branch's `async function*` form below.
      // biome-ignore lint/correctness/useYield: intentional throw-only generator
      const events = (async function* (): AsyncGenerator<StreamEvent> {
        throw err;
      })();
      return { events, response: Promise.reject(err) };
    }
    return {
      events: (async function* () {
        for (const e of turn.events) yield e;
      })(),
      response: Promise.resolve({
        stopReason: turn.stopReason,
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    } satisfies ChatStreamResult;
  });
  const chat = vi.fn(async (params: Parameters<LlmProvider["chat"]>[0]) => {
    chatCalls.push(params);
    // Walk the same cursor so a `kind: "stream"` entry placed AFTER a
    // throw acts as the stream-replay's non-streaming response.
    const turn = turns[cursor++];
    if (!turn)
      throw new Error(`repairStreamProvider: ran out of turns for chat() (cursor=${cursor})`);
    if (turn.kind !== "stream") {
      throw new Error("repairStreamProvider: chat() called but next turn is not a stream entry");
    }
    const content: ContentBlock[] = [];
    let currentText = "";
    for (const e of turn.events) {
      if (e.type === "text_delta") currentText += e.text;
      else if (e.type === "tool_start") {
        if (currentText) {
          content.push({ type: "text", text: currentText });
          currentText = "";
        }
        content.push({ type: "tool_use", id: e.id, name: e.name, input: e.input });
      }
    }
    if (currentText) content.push({ type: "text", text: currentText });
    return {
      content,
      stopReason: turn.stopReason,
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  });
  const provider: LlmProvider = {
    name: "repair-mock",
    chat,
    chatStream,
    countTokens: vi.fn(),
  };
  return { provider, chatCalls, streamCalls };
}

describe("class C in-loop repair", () => {
  it("empty end_turn → continuation prompt → next iteration completes; ephemeral turn not persisted", async () => {
    const { provider, streamCalls } = repairStreamProvider([
      { kind: "stream", events: [], stopReason: "end_turn" },
      {
        kind: "stream",
        events: [{ type: "text_delta", text: "ok now" }],
        stopReason: "end_turn",
      },
    ]);
    const turnLogger = mock<Logger>();
    const collected: StreamEvent[] = [];

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: new ToolRegistry(),
      service: stubService(),
      onEvent: async (e) => {
        collected.push(e);
      },
      turnLogger,
    });

    expect(result.text).toBe("ok now");
    expect(result.iterations).toBe(2);
    expect(result.degraded).toBeUndefined();
    // Two LLM stream calls.
    expect(streamCalls).toHaveLength(2);
    // Synthetic continuation prompt fed back to the model (visible in the
    // second iteration's history input).
    const secondCallMessages = streamCalls[1]?.messages ?? [];
    const lastUser = secondCallMessages.at(-1);
    expect(lastUser?.role).toBe("user");
    expect(lastUser?.content).toBe("Please complete your response.");
    // The synthetic user turn is NOT in newMessages — only the
    // successful assistant reply from iteration 2.
    expect(result.newMessages).toHaveLength(1);
    expect(result.newMessages[0]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "ok now" }],
    });
    // Repair telemetry.
    expect(turnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.repair",
        subtype: "empty_end_turn",
        instructions: { kind: "continuation_prompt" },
      }),
      expect.any(String),
    );
  });

  it("empty end_turn twice → degrade with empty_end_turn subtype", async () => {
    const { provider } = repairStreamProvider([
      { kind: "stream", events: [], stopReason: "end_turn" },
      { kind: "stream", events: [], stopReason: "end_turn" },
    ]);
    const turnLogger = mock<Logger>();

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: new ToolRegistry(),
      service: stubService(),
      onEvent: async () => {},
      turnLogger,
    });

    expect(result.degraded).toEqual({
      reason: "model returned an empty turn",
      subtype: "empty_end_turn",
    });
    expect(result.iterations).toBe(2);
    // The failing iteration's empty assistant content is NOT in newMessages.
    expect(result.newMessages).toHaveLength(0);
    expect(turnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.degrade",
        subtype: "empty_end_turn",
      }),
      expect.any(String),
    );
  });

  it("stream truncation (ProviderProtocolError) → non-streaming replay → success", async () => {
    const protocolErr = new ProviderProtocolError(
      "tool args failed to parse",
      new SyntaxError("unexpected token"),
    );
    const { provider, chatCalls, streamCalls } = repairStreamProvider([
      { kind: "throw", error: protocolErr },
      {
        kind: "stream",
        events: [{ type: "tool_start", id: "t1", name: "echo", input: { text: "hi" } }],
        stopReason: "tool_use",
      },
      {
        kind: "stream",
        events: [{ type: "text_delta", text: "done" }],
        stopReason: "end_turn",
      },
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
    const turnLogger = mock<Logger>();
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
      turnLogger,
    });

    expect(result.degraded).toBeUndefined();
    expect(result.text).toBe("done");
    // Iteration count: the failed-stream + non-streaming-replay is ONE
    // iteration (replay supplies the content the stream couldn't), then
    // the follow-up iteration that produces the final text. Two total.
    expect(result.iterations).toBe(2);
    // chat() was called once for the replay; chatStream() called for
    // the initial throw + the final-text iteration.
    expect(chatCalls).toHaveLength(1);
    expect(streamCalls).toHaveLength(2);
    // The recovered tool_start was forwarded onto the stream so
    // streaming delivery sees the tool_use that the failed stream never
    // emitted.
    expect(collected.some((e) => e.type === "tool_start" && e.id === "t1")).toBe(true);
    expect(turnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.repair",
        subtype: "stream_truncation",
        instructions: { kind: "stream_replay" },
      }),
      expect.any(String),
    );
  });

  it("Class A error during stream replay propagates untouched (not classified as degrade)", async () => {
    const protocolErr1 = new ProviderProtocolError("first", new Error("boom"));
    const { provider } = repairStreamProvider([{ kind: "throw", error: protocolErr1 }]);
    // Override chat() to also throw a Class A error — the design says
    // Class A handling resumes if the replay itself fails. The error
    // must propagate to the caller (NOT be caught and turned into
    // degrade — that's Class A's job).
    const replayErr = Object.assign(new Error("upstream 502"), { status: 502 });
    (provider.chat as ReturnType<typeof vi.fn>).mockReset();
    (provider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(replayErr);

    await expect(
      runStreamingAgentLoop({
        provider,
        model: "test",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: new ToolRegistry(),
        service: stubService(),
        onEvent: async () => {},
      }),
    ).rejects.toBe(replayErr);
  });

  it("ProviderProtocolError during stream replay → degrade with stream_truncation subtype", async () => {
    // First streaming attempt throws a parse error → repair consumes the
    // stream-truncation budget and invokes chat() for the replay. The
    // replay ALSO throws ProviderProtocolError (model still couldn't emit
    // clean tool-arg JSON). Per design/agent-resilience.md, this maps to
    // a degrade with the matching subtype — NOT an `errored` off-ramp.
    const streamErr = new ProviderProtocolError("first", new Error("boom"));
    const replayErr = new ProviderProtocolError("replay-too", new Error("still bad"));
    const { provider } = repairStreamProvider([{ kind: "throw", error: streamErr }]);
    (provider.chat as ReturnType<typeof vi.fn>).mockReset();
    (provider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(replayErr);
    const turnLogger = mock<Logger>();

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: new ToolRegistry(),
      service: stubService(),
      onEvent: async () => {},
      turnLogger,
    });

    expect(result.degraded).toEqual({
      reason: "non-streaming replay still could not parse tool-call arguments",
      subtype: "stream_truncation",
    });
    expect(turnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "agent.degrade", subtype: "stream_truncation" }),
      expect.any(String),
    );
  });

  it("RefusalError during stream replay → degrade with refusal subtype", async () => {
    // First streaming attempt throws a parse error → repair invokes
    // chat() for the replay. The replay throws RefusalError (model
    // refused the policy-light path of the non-streaming retry).
    // Maps to degrade with the refusal subtype, not `errored`.
    const streamErr = new ProviderProtocolError("first", new Error("boom"));
    const replayRefusal = new RefusalError("policy");
    const { provider } = repairStreamProvider([{ kind: "throw", error: streamErr }]);
    (provider.chat as ReturnType<typeof vi.fn>).mockReset();
    (provider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(replayRefusal);
    const turnLogger = mock<Logger>();

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: new ToolRegistry(),
      service: stubService(),
      onEvent: async () => {},
      turnLogger,
    });

    expect(result.degraded).toEqual({
      reason: "model refused the non-streaming replay",
      subtype: "refusal",
    });
    expect(turnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "agent.degrade", subtype: "refusal" }),
      expect.any(String),
    );
  });

  it("two consecutive ProviderProtocolErrors → degrade after budget exhausted", async () => {
    const err1 = new ProviderProtocolError("first", new Error("boom"));
    const err2 = new ProviderProtocolError("second", new Error("boom"));
    const { provider } = repairStreamProvider([
      { kind: "throw", error: err1 },
      // The first error consumes the budget and triggers a non-streaming
      // replay via chat(). Make chat() succeed cleanly, then have the
      // SECOND streaming iteration throw a fresh ProviderProtocolError —
      // budget exhausted, degrade.
      {
        kind: "stream",
        events: [{ type: "tool_start", id: "t1", name: "echo", input: {} }],
        stopReason: "tool_use",
      },
      { kind: "throw", error: err2 },
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
      messages: [{ role: "user", content: "hi" }],
      tools,
      service: stubService(),
      onEvent: async () => {},
    });

    expect(result.degraded).toEqual({
      reason: "streamed tool-call arguments could not be parsed",
      subtype: "stream_truncation",
    });
  });

  it("Anthropic-style refusal stopReason → immediate degrade, no repair attempt", async () => {
    const { provider, streamCalls } = repairStreamProvider([
      { kind: "stream", events: [], stopReason: "refusal" },
    ]);
    const turnLogger = mock<Logger>();

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "naughty" }],
      tools: new ToolRegistry(),
      service: stubService(),
      onEvent: async () => {},
      turnLogger,
    });

    expect(result.degraded).toEqual({
      reason: "model returned a policy refusal",
      subtype: "refusal",
    });
    // Exactly one LLM call — refusal does not consume continuation budget.
    expect(streamCalls).toHaveLength(1);
    expect(result.iterations).toBe(1);
    expect(turnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "agent.degrade", subtype: "refusal" }),
      expect.any(String),
    );
  });

  it("OpenAI-compat RefusalError thrown from stream → degrade with refusal subtype", async () => {
    // FallbackLlmProvider treats RefusalError as non-retriable (per
    // isRetriableProviderError) and propagates it through `chatStream`
    // — the loop catches it and the classifier routes to degrade.
    const refusal = new RefusalError("policy violation");
    const { provider } = repairStreamProvider([{ kind: "throw", error: refusal }]);
    const turnLogger = mock<Logger>();

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "naughty" }],
      tools: new ToolRegistry(),
      service: stubService(),
      onEvent: async () => {},
      turnLogger,
    });

    expect(result.degraded).toEqual({
      reason: "model refused the request",
      subtype: "refusal",
    });
    expect(turnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "agent.degrade", subtype: "refusal" }),
      expect.any(String),
    );
  });

  it("budgets are independent: empty_end_turn fires then stream_truncation fires, both repair", async () => {
    const protocolErr = new ProviderProtocolError("oops", new Error("boom"));
    const { provider } = repairStreamProvider([
      // iteration 1: empty end_turn → repair via continuation prompt
      { kind: "stream", events: [], stopReason: "end_turn" },
      // iteration 2: stream throws → repair via non-streaming replay
      { kind: "throw", error: protocolErr },
      // chat() replay for iteration 2: tool_use, then iteration 3 completes
      {
        kind: "stream",
        events: [{ type: "tool_start", id: "t1", name: "echo", input: {} }],
        stopReason: "tool_use",
      },
      {
        kind: "stream",
        events: [{ type: "text_delta", text: "done" }],
        stopReason: "end_turn",
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
      messages: [{ role: "user", content: "hi" }],
      tools,
      service: stubService(),
      onEvent: async () => {},
    });

    expect(result.degraded).toBeUndefined();
    expect(result.text).toBe("done");
  });

  it("persistence boundary: successful tool round persists; failing iteration + synthetic prompt do not", async () => {
    // iteration 1: tool_use; iteration 2: empty end_turn (fails); iteration 3: empty end_turn (degrade)
    const { provider } = repairStreamProvider([
      {
        kind: "stream",
        events: [{ type: "tool_start", id: "t1", name: "echo", input: { text: "x" } }],
        stopReason: "tool_use",
      },
      { kind: "stream", events: [], stopReason: "end_turn" },
      { kind: "stream", events: [], stopReason: "end_turn" },
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
      messages: [{ role: "user", content: "hi" }],
      tools,
      service: stubService(),
      onEvent: async () => {},
    });

    expect(result.degraded?.subtype).toBe("empty_end_turn");
    // newMessages should contain the successful tool round (assistant
    // tool_use + user tool_result) but NOT the empty assistant from
    // iteration 2, NOT the synthetic continuation prompt, and NOT the
    // empty assistant from iteration 3.
    expect(result.newMessages).toHaveLength(2);
    expect(result.newMessages[0]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "echo", input: { text: "x" } }],
    });
    expect(result.newMessages[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: "pong from x" }],
    });
    // No "Please complete your response." synthetic prompt should
    // appear among the persistable messages.
    for (const m of result.newMessages) {
      if (typeof m.content === "string") {
        expect(m.content).not.toMatch(/please complete/i);
      }
    }
  });

  it("does not treat unrelated errors as Class C", async () => {
    // A bare error with no Class C signal must propagate untouched —
    // it's Class A / B and the orchestrator translates it into the
    // appropriate retry decision.
    const transientErr = Object.assign(new Error("upstream 502"), { status: 502 });
    const { provider } = repairStreamProvider([{ kind: "throw", error: transientErr }]);

    await expect(
      runStreamingAgentLoop({
        provider,
        model: "test",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: new ToolRegistry(),
        service: stubService(),
        onEvent: async () => {},
      }),
    ).rejects.toBe(transientErr);
  });
});
