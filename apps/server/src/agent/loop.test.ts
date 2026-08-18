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
import { expectDefined } from "../test/assertions.js";
import { mockFilesService } from "../test/factories.js";
import type {
  AgentLoopParams,
  AgentLoopResult,
  StepRunner,
  StreamingAgentLoopParams,
} from "./loop.js";
import { runAgentLoop, runStreamingAgentLoop } from "./loop.js";
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
    files: mockFilesService(),
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

// Fields these tests almost never vary. Defaulted by `testRunAgentLoop` /
// `testRunStreamingAgentLoop` so each call only states what's behaviourally
// relevant (provider, tools, messages, plus the variant onEvent / mock
// turnLogger / etc.). Overriding any of them just means setting it in
// the override object.
type LoopDefaultable = "model" | "systemPrompt" | "service" | "turnLogger";
type LoopOverrides = Omit<AgentLoopParams, LoopDefaultable> &
  Partial<Pick<AgentLoopParams, LoopDefaultable>>;
type StreamingLoopOverrides = Omit<StreamingAgentLoopParams, LoopDefaultable> &
  Partial<Pick<StreamingAgentLoopParams, LoopDefaultable>>;

function testRunAgentLoop(overrides: LoopOverrides): Promise<AgentLoopResult> {
  return runAgentLoop({
    model: "test",
    systemPrompt: "sys",
    service: stubService(),
    turnLogger: logger,
    ...overrides,
  });
}

function testRunStreamingAgentLoop(overrides: StreamingLoopOverrides): Promise<AgentLoopResult> {
  return runStreamingAgentLoop({
    model: "test",
    systemPrompt: "sys",
    service: stubService(),
    turnLogger: logger,
    ...overrides,
  });
}

describe("runAgentLoop", () => {
  it("returns text on single-turn end_turn", async () => {
    const provider = mockProvider([textResponse("Hello!")]);
    const tools = new ToolRegistry();

    const result = await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "Hi" }],
      tools,
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

    const result = await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "echo ping" }],
      tools,
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

    const result = await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "use magic" }],
      tools,
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

    const result = await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "fail" }],
      tools,
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

    const result = await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "do both" }],
      tools,
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

    const result = await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "loop" }],
      tools,
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

    const result = await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "echo" }],
      tools,
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

    const result = await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "echo" }],
      tools,
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

    await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "hi" }],
      tools,
    });

    const callArgs = vi.mocked(provider.chat).mock.calls[0]![0];
    expect(callArgs.tools).toBeUndefined();
  });

  it("does not mutate the original messages array", async () => {
    const provider = mockProvider([textResponse("done")]);
    const tools = new ToolRegistry();
    const original = [{ role: "user" as const, content: "hi" }];

    await testRunAgentLoop({
      provider,
      messages: original,
      tools,
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

    await testRunAgentLoop({
      provider,
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

    const result = await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "gen three" }],
      tools,
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

    const result = await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "mixed" }],
      tools,
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

    await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "two writes" }],
      tools,
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

    const result = await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "safe + ghost + safe" }],
      tools,
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

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "hi" }],
      tools,
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

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "echo ping" }],
      tools,
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

    await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "hi" }],
      tools,
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

    await testRunStreamingAgentLoop({
      provider,
      messages: original,
      tools,
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

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "loop" }],
      tools,
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

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "echo" }],
      tools,
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

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "echo" }],
      tools,
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
        testRunStreamingAgentLoop({
          provider,
          messages: [{ role: "user", content: "hi" }],
          tools: new ToolRegistry(),
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

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "think" }],
      tools,
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

    const result = await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "go" }],
      tools,
      stepRun,
    });

    expect(stepRunCalls).toEqual([{ id: "tool-iter1-0" }]);
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

    const result = await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "go" }],
      tools,
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

    await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "go" }],
      tools,
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

    await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "go" }],
      tools,
      stepRun,
    });

    expect(ids).toEqual(["tool-iter1-0", "tool-iter1-1"]);
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

    await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "go" }],
      tools,
      onEvent: async () => {},
      stepRun,
    });

    expect(stepRunCalls).toEqual(["tool-iter1-0"]);
  });

  it("emits identical step ids across attempts even when the LLM mints different tool_use ids", async () => {
    // Inngest replays the function from the top on retry; the streaming
    // LLM call is non-durable, so each replay calls the provider fresh and
    // gets fresh `tool_use_id`s. The durable step id must therefore not
    // depend on the LLM-minted id — otherwise the planner can't match the
    // cached step on attempt N+1 and the run fails with
    // "Could not find step <hash> to run; timed out".
    function makeProvider(toolUseId: string) {
      return mockProvider([toolUseResponse("paid", toolUseId, { q: "hi" }), textResponse("done")]);
    }

    function makeTools() {
      const tools = new ToolRegistry();
      tools.register({
        name: "paid",
        description: "expensive",
        inputSchema: { type: "object" },
        durable: true,
        handler: async () => "paid-result",
      });
      return tools;
    }

    const attempt0Ids: string[] = [];
    await testRunAgentLoop({
      provider: makeProvider("toolu_attempt0"),
      messages: [{ role: "user", content: "go" }],
      tools: makeTools(),
      stepRun: async (id, fn) => {
        attempt0Ids.push(id);
        return fn();
      },
    });

    const attempt1Ids: string[] = [];
    await testRunAgentLoop({
      provider: makeProvider("toolu_attempt1_FRESH"),
      messages: [{ role: "user", content: "go" }],
      tools: makeTools(),
      stepRun: async (id, fn) => {
        attempt1Ids.push(id);
        return fn();
      },
    });

    expect(attempt0Ids).toEqual(attempt1Ids);
    expect(attempt0Ids).toEqual(["tool-iter1-0"]);
  });

  it("returns a cached step result even when attempt 1 picks a different tool at the same position", async () => {
    // The accepted trade-off of position-based step ids: if attempt 0
    // cached `tool-iter1-0` for tool A and attempt 1's fresh LLM call
    // emits tool B at the same position, Inngest replays the cached A
    // result against B's `tool_use`. The Anthropic pairing invariant
    // (every tool_use answered by a tool_result with matching id) still
    // holds because `toolUseId` is rebuilt from the current attempt's
    // block; the *content* is from the prior tool. This pins the
    // behavior so a future change that silently restores LLM-driven
    // step ids — and accidentally "fixes" this mismatch by deadlocking
    // on retry — fails here. See design/crash-recovery.md.
    const tools = new ToolRegistry();
    tools.register({
      name: "read_a",
      description: "read A",
      inputSchema: { type: "object" },
      durable: true,
      handler: async () => "contents-of-A",
    });
    tools.register({
      name: "read_b",
      description: "read B",
      inputSchema: { type: "object" },
      durable: true,
      handler: async () => "contents-of-B",
    });

    // Simulate Inngest's cache: stepRun returns a prior attempt's value
    // when the id matches, regardless of what the handler body would do.
    const cache = new Map<string, string>([["tool-iter1-0", "contents-of-A"]]);
    const stepRun: StepRunner = async (id, fn) => {
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      const fresh = await fn();
      cache.set(id, fresh);
      return fresh;
    };

    const result = await testRunAgentLoop({
      // Attempt 1: the model emits read_b at position 0 (different tool
      // than attempt 0 would have cached). The id is fresh too.
      provider: mockProvider([
        toolUseResponse("read_b", "toolu_attempt1_B", {}),
        textResponse("done"),
      ]),
      messages: [{ role: "user", content: "go" }],
      tools,
      stepRun,
    });

    const toolResult = (result.messages[2]!.content as ContentBlock[])[0];
    expect(toolResult).toEqual({
      type: "tool_result",
      // Current attempt's tool_use_id — pairing invariant preserved.
      toolUseId: "toolu_attempt1_B",
      // Cached content from attempt 0's read_a — the documented mismatch.
      content: "contents-of-A",
    });
  });
});

// The cap is per-model and set by the caller. Reasoning shares it, so a
// cap sized for reply text alone truncates a turn that thinks — and
// `classifyPostStream` reports a truncated turn as `ok`, so it is
// delivered as if finished.
describe("maxTokens", () => {
  it("forwards the caller's cap to the provider", async () => {
    const provider = mockProvider([textResponse("done")]);

    await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "hi" }],
      tools: new ToolRegistry(),
      maxTokens: 64_000,
    });

    const sent = expectDefined(vi.mocked(provider.chat).mock.calls[0])[0];
    expect(sent.maxTokens).toBe(64_000);
  });

  it("leaves the cap unset when the caller passes none", async () => {
    const provider = mockProvider([textResponse("done")]);

    await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "hi" }],
      tools: new ToolRegistry(),
    });

    const sent = expectDefined(vi.mocked(provider.chat).mock.calls[0])[0];
    expect(sent.maxTokens).toBeUndefined();
  });
});

// Thinking blocks must reach the provider exactly as emitted: the API
// rejects modified ones ("each thinking block must contain thinking"),
// so the loop forwards history verbatim. Trimming stale thinking from a
// long context is the server's job via context editing.
describe("thinking blocks in history", () => {
  it("forwards older thinking blocks to the provider unmodified", async () => {
    const provider = mockProvider([textResponse("done")]);
    // A later assistant turn makes the first one "old" — the case that
    // used to have its thinking text blanked on the way out.
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old reasoning", signature: "sig1" },
          { type: "text", text: "old answer" },
        ],
      },
      { role: "user", content: "follow up" },
      { role: "assistant", content: [{ type: "text", text: "second answer" }] },
      { role: "user", content: "again" },
    ];

    await testRunAgentLoop({ provider, messages, tools: new ToolRegistry() });

    const sent = expectDefined(vi.mocked(provider.chat).mock.calls[0])[0];
    expect(sent.messages[0]?.content).toEqual([
      { type: "thinking", thinking: "old reasoning", signature: "sig1" },
      { type: "text", text: "old answer" },
    ]);
  });

  it("forwards an empty-text thinking block rather than dropping it", async () => {
    // `display: "omitted"` (the default on the 5 series) returns thinking
    // blocks whose text is empty but whose signature is real. Dropping
    // them can trigger ordering/signature errors, so they ride along
    // untouched like any other block.
    const provider = mockProvider([textResponse("done")]);
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig-omitted" },
          { type: "text", text: "answer" },
        ],
      },
      { role: "user", content: "follow up" },
    ];

    await testRunAgentLoop({ provider, messages, tools: new ToolRegistry() });

    const sent = expectDefined(vi.mocked(provider.chat).mock.calls[0])[0];
    expect(sent.messages[0]?.content).toEqual([
      { type: "thinking", thinking: "", signature: "sig-omitted" },
      { type: "text", text: "answer" },
    ]);
  });
});

// Pre-flight history sanitization runs validateHistory and emits a
// warn-level repair log when the validator returns repairs. A user message
// with a tool_result whose toolUseId has no matching prior tool_use is the
// minimal repro — `validateHistory` flags it as `dropped_stray_tool_result`,
// which routes through the `agent loop history invariants repaired` warn
// emission. Tests below pin that the warn lands on the injected
// per-invocation `turnLogger` across both loop variants and on the
// iteration-limit path.
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
      await testRunStreamingAgentLoop({
        provider,
        messages: historyWithStrayToolResult(),
        tools: new ToolRegistry(),
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

  it("routes the history-repair warn through turnLogger in runAgentLoop too", async () => {
    const provider = mockProvider([textResponse("ok")]);
    const turnLogger = mock<Logger>();

    await testRunAgentLoop({
      provider,
      messages: historyWithStrayToolResult(),
      tools: new ToolRegistry(),
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

    await testRunAgentLoop({
      provider,
      messages: [{ role: "user", content: "loop" }],
      tools,
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

describe("in-loop model-misbehavior repair", () => {
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

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "hi" }],
      tools: new ToolRegistry(),
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

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "hi" }],
      tools: new ToolRegistry(),
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

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "hi" }],
      tools,
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

  it("transport-layer error during stream replay propagates untouched (not classified as degrade)", async () => {
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
      testRunStreamingAgentLoop({
        provider,
        messages: [{ role: "user", content: "hi" }],
        tools: new ToolRegistry(),
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

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "hi" }],
      tools: new ToolRegistry(),
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

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "hi" }],
      tools: new ToolRegistry(),
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

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "hi" }],
      tools,
      onEvent: async () => {},
    });

    expect(result.degraded).toEqual({
      reason: "streamed tool-call arguments could not be parsed",
      subtype: "stream_truncation",
    });
  });

  it("anthropic-style refusal stopReason → immediate degrade, no repair attempt", async () => {
    const { provider, streamCalls } = repairStreamProvider([
      { kind: "stream", events: [], stopReason: "refusal" },
    ]);
    const turnLogger = mock<Logger>();

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "naughty" }],
      tools: new ToolRegistry(),
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

  it("context_overflow stopReason with no content → immediate degrade, no continuation prompt", async () => {
    // The dangerous shape: an overflow that emitted nothing. Read as a
    // normal `max_tokens` completion this returns a successful turn with an
    // empty assistant message; read as an empty `end_turn` it earns a
    // continuation prompt, which appends tokens to a window that just
    // overflowed. Neither happens — one stream call, then degrade.
    const { provider, streamCalls } = repairStreamProvider([
      { kind: "stream", events: [], stopReason: "context_overflow" },
    ]);
    const turnLogger = mock<Logger>();

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "the tenth turn of a huge conversation" }],
      tools: new ToolRegistry(),
      onEvent: async () => {},
      turnLogger,
    });

    expect(result.degraded).toEqual({
      reason: "request exceeded the model's context window",
      subtype: "context_overflow",
    });
    expect(streamCalls).toHaveLength(1);
    expect(result.iterations).toBe(1);
    // Nothing persistable: no blank assistant message, no synthetic prompt.
    expect(result.newMessages).toHaveLength(0);
    expect(result.text).toBe("");
    expect(turnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "agent.degrade", subtype: "context_overflow" }),
      expect.any(String),
    );
  });

  it("context_overflow stopReason with partial content → degrade; the fragment is not persisted", async () => {
    const { provider } = repairStreamProvider([
      {
        kind: "stream",
        events: [{ type: "text_delta", text: "Here are the first three of the ten items you as" }],
        stopReason: "context_overflow",
      },
    ]);

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "list ten things" }],
      tools: new ToolRegistry(),
      onEvent: async () => {},
    });

    expect(result.degraded).toEqual({
      reason: "request exceeded the model's context window",
      subtype: "context_overflow",
    });
    // A truncated answer must not land in history looking complete — the
    // orchestrator's apology replaces it.
    expect(result.newMessages).toHaveLength(0);
    expect(result.text).toBe("");
  });

  it("context_overflow degrades even mid-turn, with completed tool iterations still persisted", async () => {
    // Overflow can arrive after real work has landed. The prior iteration's
    // tool_use / tool_result pair completed and stays; only the overflowing
    // iteration is dropped.
    const { provider } = repairStreamProvider([
      {
        kind: "stream",
        events: [{ type: "tool_start", id: "t1", name: "echo", input: {} }],
        stopReason: "tool_use",
      },
      { kind: "stream", events: [], stopReason: "context_overflow" },
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

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "echo then answer" }],
      tools,
      onEvent: async () => {},
    });

    expect(result.degraded?.subtype).toBe("context_overflow");
    expect(result.iterations).toBe(2);
    expect(result.newMessages).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }] },
    ]);
  });

  it("openai-compat RefusalError thrown from stream → degrade with refusal subtype", async () => {
    // FallbackLlmProvider treats RefusalError as non-retriable (per
    // isRetriableProviderError) and propagates it through `chatStream`
    // — the loop catches it and the classifier routes to degrade.
    const refusal = new RefusalError("policy violation");
    const { provider } = repairStreamProvider([{ kind: "throw", error: refusal }]);
    const turnLogger = mock<Logger>();

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "naughty" }],
      tools: new ToolRegistry(),
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

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "hi" }],
      tools,
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

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "hi" }],
      tools,
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

  it("does not classify unrelated stream errors as model-misbehavior repairs", async () => {
    // A bare error with no Class C signal must propagate untouched —
    // it's Class A / B and the orchestrator translates it into the
    // appropriate retry decision.
    const transientErr = Object.assign(new Error("upstream 502"), { status: 502 });
    const { provider } = repairStreamProvider([{ kind: "throw", error: transientErr }]);

    await expect(
      testRunStreamingAgentLoop({
        provider,
        messages: [{ role: "user", content: "hi" }],
        tools: new ToolRegistry(),
        onEvent: async () => {},
      }),
    ).rejects.toBe(transientErr);
  });
});

// --- Loop pathology fingerprint (Class D) ---

describe("loop-pathology fingerprint", () => {
  function readOnlyTool() {
    return defineTool({
      name: "read_file",
      description: "read a file",
      schema: z.object({ path: z.string() }),
      sideEffectful: false,
      handler: async (input) => `contents of ${input.path}`,
    });
  }

  function writeTool() {
    return defineTool({
      name: "write_file",
      description: "write a file",
      schema: z.object({ path: z.string() }),
      sideEffectful: true,
      handler: async (input) => `wrote ${input.path}`,
    });
  }

  function toolUseTurn(toolName: string, id: string, input: unknown): MockStreamTurn {
    return {
      events: [{ type: "tool_start", id, name: toolName, input }],
      stopReason: "tool_use",
    };
  }

  it("consecutive trigger: three identical side-effect-free iterations → stuck_loop", async () => {
    const provider = mockStreamProvider([
      toolUseTurn("read_file", "t1", { path: "x.txt" }),
      toolUseTurn("read_file", "t2", { path: "x.txt" }),
      toolUseTurn("read_file", "t3", { path: "x.txt" }),
    ]);
    const tools = new ToolRegistry();
    tools.register(readOnlyTool());
    const turnLogger = mock<Logger>();

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "go" }],
      tools,
      onEvent: async () => {},
      turnLogger,
    });

    expect(result.degraded).toEqual({ reason: "stuck_loop", subtype: "stuck_loop" });
    // Exactly three iterations — the trip fires at the end of iteration 3
    // before another LLM call is made.
    expect(result.iterations).toBe(3);
    expect(turnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.degrade",
        reason: "stuck_loop",
        subtype: "stuck_loop",
        consecutiveCount: 3,
      }),
      expect.any(String),
    );
  });

  it("a side-effectful tool call resets the consecutive counter — three identical iterations do NOT trip", async () => {
    // Run the same iteration 4 times: an iteration with a write tool
    // produces a side effect; the consecutive counter must reset around
    // it so even though we see four identical fingerprints, no three
    // are consecutive among the side-effect-free runs.
    const provider = mockStreamProvider([
      toolUseTurn("write_file", "t1", { path: "x.txt" }),
      toolUseTurn("write_file", "t2", { path: "x.txt" }),
      toolUseTurn("write_file", "t3", { path: "x.txt" }),
      // Fourth iteration completes with end_turn so the loop exits
      // cleanly instead of running out of turns.
      { events: [{ type: "text_delta", text: "done" }], stopReason: "end_turn" },
    ]);
    const tools = new ToolRegistry();
    tools.register(writeTool());

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "go" }],
      tools,
      onEvent: async () => {},
    });

    // No trip — the loop completed naturally.
    expect(result.degraded).toBeUndefined();
    expect(result.text).toBe("done");
    expect(result.iterations).toBe(4);
  });

  it("mixed-side-effect iteration: one read + one write resets the consecutive counter", async () => {
    // Each iteration emits a read AND a write. `iterationHadSideEffect`
    // returns true if ANY tool call in the iteration had a side effect,
    // so the write makes the iteration count as progress and the
    // consecutive counter never accumulates — three identical iterations
    // must NOT trip stuck_loop.
    function mixedTurn(readId: string, writeId: string): MockStreamTurn {
      return {
        events: [
          { type: "tool_start", id: readId, name: "read_file", input: { path: "x.txt" } },
          { type: "tool_start", id: writeId, name: "write_file", input: { path: "x.txt" } },
        ],
        stopReason: "tool_use",
      };
    }
    const provider = mockStreamProvider([
      mixedTurn("r1", "w1"),
      mixedTurn("r2", "w2"),
      mixedTurn("r3", "w3"),
      { events: [{ type: "text_delta", text: "done" }], stopReason: "end_turn" },
    ]);
    const tools = new ToolRegistry();
    tools.register(readOnlyTool());
    tools.register(writeTool());

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "go" }],
      tools,
      onEvent: async () => {},
    });

    expect(result.degraded).toBeUndefined();
    expect(result.text).toBe("done");
    expect(result.iterations).toBe(4);
  });

  it("cumulative trigger: alternating A, B, A, B, A → stuck_loop_cumulative", async () => {
    // Two interleaved fingerprints; neither reaches three consecutive
    // but `A` accumulates five total side-effect-free occurrences and
    // trips the cumulative limit.
    const provider = mockStreamProvider([
      toolUseTurn("read_file", "t1", { path: "A" }),
      toolUseTurn("read_file", "t2", { path: "B" }),
      toolUseTurn("read_file", "t3", { path: "A" }),
      toolUseTurn("read_file", "t4", { path: "B" }),
      toolUseTurn("read_file", "t5", { path: "A" }),
      toolUseTurn("read_file", "t6", { path: "B" }),
      toolUseTurn("read_file", "t7", { path: "A" }),
      toolUseTurn("read_file", "t8", { path: "B" }),
      toolUseTurn("read_file", "t9", { path: "A" }),
    ]);
    const tools = new ToolRegistry();
    tools.register(readOnlyTool());
    const turnLogger = mock<Logger>();

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "go" }],
      tools,
      onEvent: async () => {},
      turnLogger,
    });

    expect(result.degraded).toEqual({
      reason: "stuck_loop",
      subtype: "stuck_loop_cumulative",
    });
    // A appears at iterations 1, 3, 5, 7, 9 — the fifth occurrence trips
    // the cumulative limit at iteration 9.
    expect(result.iterations).toBe(9);
    expect(turnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.degrade",
        reason: "stuck_loop",
        subtype: "stuck_loop_cumulative",
        cumulativeCount: 5,
      }),
      expect.any(String),
    );
  });

  it("varying args (a.txt, b.txt, c.txt) do NOT trip — different fingerprints", async () => {
    // Three side-effect-free iterations against different paths is
    // legitimate read-only exploration, not a stuck loop. The
    // fingerprint must include args; name-only hashing would false-
    // positive on this sequence.
    const provider = mockStreamProvider([
      toolUseTurn("read_file", "t1", { path: "a.txt" }),
      toolUseTurn("read_file", "t2", { path: "b.txt" }),
      toolUseTurn("read_file", "t3", { path: "c.txt" }),
      { events: [{ type: "text_delta", text: "done" }], stopReason: "end_turn" },
    ]);
    const tools = new ToolRegistry();
    tools.register(readOnlyTool());

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "explore" }],
      tools,
      onEvent: async () => {},
    });

    expect(result.degraded).toBeUndefined();
    expect(result.text).toBe("done");
    expect(result.iterations).toBe(4);
  });

  it("identical tool calls with differing assistant text prefixes still match — text excluded from the hash", async () => {
    // Two iterations emit the same read_file call but with different
    // hedging preambles before the tool_use. The fingerprint excludes
    // text, so the same fingerprint accumulates across both iterations.
    // Add a third identical iteration with NO text to push past the
    // three-consecutive threshold.
    const provider = mockStreamProvider([
      {
        events: [
          { type: "text_delta", text: "Let me check… " },
          { type: "tool_start", id: "t1", name: "read_file", input: { path: "x" } },
        ],
        stopReason: "tool_use",
      },
      {
        events: [
          { type: "text_delta", text: "Hmm, let me re-read. " },
          { type: "tool_start", id: "t2", name: "read_file", input: { path: "x" } },
        ],
        stopReason: "tool_use",
      },
      toolUseTurn("read_file", "t3", { path: "x" }),
    ]);
    const tools = new ToolRegistry();
    tools.register(readOnlyTool());

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "check" }],
      tools,
      onEvent: async () => {},
    });

    expect(result.degraded).toEqual({ reason: "stuck_loop", subtype: "stuck_loop" });
    expect(result.iterations).toBe(3);
  });

  it("parallel-tool emission order does not move the fingerprint — sort-stable", async () => {
    // Two iterations emit the same two tool calls in opposite orders.
    // The third iteration matches one of them. All three must hash to
    // the same fingerprint and trip the consecutive threshold.
    const provider = mockStreamProvider([
      {
        events: [
          { type: "tool_start", id: "t1a", name: "read_file", input: { path: "a" } },
          { type: "tool_start", id: "t1b", name: "list_files", input: { path: "/" } },
        ],
        stopReason: "tool_use",
      },
      {
        events: [
          { type: "tool_start", id: "t2a", name: "list_files", input: { path: "/" } },
          { type: "tool_start", id: "t2b", name: "read_file", input: { path: "a" } },
        ],
        stopReason: "tool_use",
      },
      {
        events: [
          { type: "tool_start", id: "t3a", name: "read_file", input: { path: "a" } },
          { type: "tool_start", id: "t3b", name: "list_files", input: { path: "/" } },
        ],
        stopReason: "tool_use",
      },
    ]);
    const tools = new ToolRegistry();
    tools.register(readOnlyTool());
    tools.register(
      defineTool({
        name: "list_files",
        description: "list",
        schema: z.object({ path: z.string() }),
        sideEffectful: false,
        handler: async (input) => `listing of ${input.path}`,
      }),
    );

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "go" }],
      tools,
      onEvent: async () => {},
    });

    expect(result.degraded).toEqual({ reason: "stuck_loop", subtype: "stuck_loop" });
    expect(result.iterations).toBe(3);
  });

  it("tool without sideEffectful flag defaults to true (fail-safe) — does NOT trip", async () => {
    // A tool declared with no `sideEffectful` field defaults to "yes,
    // side-effectful" at the consumer level. Three identical iterations
    // with such a tool must NOT trip the consecutive trigger — that's
    // the fail-safe guarantee third-party tools depend on.
    const unflaggedTool = defineTool({
      name: "mystery",
      description: "no flag",
      schema: z.object({}),
      handler: async () => "ok",
    });
    expect(unflaggedTool.sideEffectful).toBeUndefined();

    const provider = mockStreamProvider([
      toolUseTurn("mystery", "t1", {}),
      toolUseTurn("mystery", "t2", {}),
      toolUseTurn("mystery", "t3", {}),
      { events: [{ type: "text_delta", text: "done" }], stopReason: "end_turn" },
    ]);
    const tools = new ToolRegistry();
    tools.register(unflaggedTool);

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "go" }],
      tools,
      onEvent: async () => {},
    });

    expect(result.degraded).toBeUndefined();
    expect(result.iterations).toBe(4);
  });

  it("errored tool calls (no real side effect) still count toward the fingerprint counter", async () => {
    // An iteration whose tool handler throws produces an isError
    // tool_result — no real side effect on the world. The "free upside"
    // path: identical malformed-args sequences should trip Class D
    // rather than burning to the iteration cap. The tool is declared
    // sideEffectful: true (its successful path WOULD affect state) so
    // this also proves the side-effect gate looks at isError, not the
    // spec flag in isolation.
    const erroringTool = defineTool({
      name: "writer",
      description: "writes",
      schema: z.object({ path: z.string() }),
      sideEffectful: true,
      handler: async () => {
        throw new Error("write failed");
      },
    });
    const provider = mockStreamProvider([
      toolUseTurn("writer", "t1", { path: "x" }),
      toolUseTurn("writer", "t2", { path: "x" }),
      toolUseTurn("writer", "t3", { path: "x" }),
    ]);
    const tools = new ToolRegistry();
    tools.register(erroringTool);

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "go" }],
      tools,
      onEvent: async () => {},
    });

    expect(result.degraded).toEqual({ reason: "stuck_loop", subtype: "stuck_loop" });
    expect(result.iterations).toBe(3);
  });

  it("persistence boundary: trip iteration's tool_use + tool_result pair is NOT persisted; prior identical iterations ARE", async () => {
    // Class D consecutive trip on iteration 3. The first two iterations
    // produced their own (identical, side-effect-free) tool_use +
    // tool_result pairs that lived to completion — they ARE persisted.
    // The third iteration is the one whose response triggered the
    // degrade and per design/agent-resilience.md → Persistence boundary
    // on a degraded turn, must NOT be persisted.
    const provider = mockStreamProvider([
      toolUseTurn("read_file", "t1", { path: "x.txt" }),
      toolUseTurn("read_file", "t2", { path: "x.txt" }),
      toolUseTurn("read_file", "t3", { path: "x.txt" }),
    ]);
    const tools = new ToolRegistry();
    tools.register(readOnlyTool());

    const result = await testRunStreamingAgentLoop({
      provider,
      messages: [{ role: "user", content: "go" }],
      tools,
      onEvent: async () => {},
    });

    expect(result.degraded).toEqual({ reason: "stuck_loop", subtype: "stuck_loop" });
    // Iterations 1 and 2: assistant tool_use + user tool_result each.
    // Iteration 3 (the trip) contributes nothing to newMessages.
    expect(result.newMessages).toHaveLength(4);
    expect(result.newMessages[0]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "x.txt" } }],
    });
    expect(result.newMessages[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: "contents of x.txt" }],
    });
    expect(result.newMessages[2]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "t2", name: "read_file", input: { path: "x.txt" } }],
    });
    expect(result.newMessages[3]).toEqual({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t2", content: "contents of x.txt" }],
    });
    // Negative assertion: the trip iteration's id (t3) appears in no
    // persisted message — neither as tool_use nor as tool_result.
    const serialized = JSON.stringify(result.newMessages);
    expect(serialized).not.toContain("t3");
  });
});

// --- Volume-cluster trigger (Class D, per-tool budget) ---

describe("volume-cluster trigger", () => {
  function budgetedTool(name: string, budget: number, sideEffectful = false) {
    return defineTool({
      name,
      description: `mock ${name}`,
      schema: z.object({ q: z.string() }),
      parallelSafe: true,
      sideEffectful,
      invocationBudget: budget,
      handler: async (input) => `result for ${input.q}`,
    });
  }

  function toolUseTurn(toolName: string, id: string, input: unknown): MockStreamTurn {
    return {
      events: [{ type: "tool_start", id, name: toolName, input }],
      stopReason: "tool_use",
    };
  }

  it("budget=2 admits the first 2 iterations, intercepts the 3rd batch with synthetic tool_result", async () => {
    // Three sequential iterations each call the same budgeted tool —
    // three batches. The first two execute; the third batch intercepts
    // before the handler runs. budget counts iterations (batches), not
    // individual calls.
    const provider = mockStreamProvider([
      toolUseTurn("img", "t1", { q: "a" }),
      toolUseTurn("img", "t2", { q: "b" }),
      toolUseTurn("img", "t3", { q: "c" }),
      // Fourth turn: model gives up and replies in text after seeing the intercept.
      { events: [{ type: "text_delta", text: "ok" }], stopReason: "end_turn" },
    ]);
    const tools = new ToolRegistry();
    // Real-tool handler that ran for "a" and "b" appears as a successful
    // tool_result; t3's synthetic is `isError: true`.
    tools.register(budgetedTool("img", 2));
    const turnLogger = mock<Logger>();

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools,
      service: stubService(),
      onEvent: async () => {},
      turnLogger,
    });

    expect(result.degraded).toBeUndefined();
    expect(result.iterations).toBe(4);
    // Pull out tool_result blocks across the persisted history.
    const toolResults = result.newMessages
      .filter((m) => m.role === "user")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_result");
    expect(toolResults).toHaveLength(3);
    const byId = new Map(
      toolResults.map((r) => [
        (r as { toolUseId: string }).toolUseId,
        r as { toolUseId: string; isError?: boolean; content: unknown },
      ]),
    );
    expect(byId.get("t1")?.isError).toBeUndefined();
    expect(byId.get("t2")?.isError).toBeUndefined();
    expect(byId.get("t3")?.isError).toBe(true);
    // Synthetic carries the intercepted tool_use's id (Anthropic pairing).
    expect(byId.get("t3")?.toolUseId).toBe("t3");
    // Telemetry on the intercept — batchCount: 3 (third iteration),
    // callCount: 3 (three tool_use blocks total across the turn).
    expect(turnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.repair",
        subtype: "volume_cluster",
        tool: "img",
        batchCount: 3,
        callCount: 3,
        blocksInBatch: 1,
        budget: 2,
      }),
      expect.any(String),
    );
  });

  it("counter persists across mixed-outcome sequences — successes do not reset", async () => {
    // Same budget=2 but the first two calls succeed; the 3rd would still
    // be intercepted. A failure-only counter would mistakenly reset on
    // each success — this pins the volume framing.
    const provider = mockStreamProvider([
      toolUseTurn("img", "t1", { q: "a" }),
      toolUseTurn("img", "t2", { q: "b" }),
      toolUseTurn("img", "t3", { q: "c" }),
      { events: [{ type: "text_delta", text: "done" }], stopReason: "end_turn" },
    ]);
    const tools = new ToolRegistry();
    tools.register(budgetedTool("img", 2)); // handler always succeeds

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools,
      service: stubService(),
      onEvent: async () => {},
      turnLogger: logger,
    });

    expect(result.degraded).toBeUndefined();
    const toolResults = result.newMessages
      .filter((m) => m.role === "user")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_result");
    // 2 successes + 1 intercept (the 3rd call's synthetic isError).
    expect(toolResults.filter((r) => "isError" in r && r.isError === true)).toHaveLength(1);
    expect(toolResults.filter((r) => !("isError" in r && r.isError === true))).toHaveLength(2);
  });

  it("different tools have independent counters — exceeding one budget doesn't penalize another", async () => {
    // img budget=2, search budget=5. Three img calls in a row — third
    // intercepts. A subsequent search call must execute, not get caught
    // by img's exhausted budget.
    const provider = mockStreamProvider([
      toolUseTurn("img", "t1", { q: "a" }),
      toolUseTurn("img", "t2", { q: "b" }),
      toolUseTurn("img", "t3", { q: "c" }),
      toolUseTurn("search", "s1", { q: "x" }),
      { events: [{ type: "text_delta", text: "done" }], stopReason: "end_turn" },
    ]);
    const tools = new ToolRegistry();
    tools.register(budgetedTool("img", 2));
    tools.register(budgetedTool("search", 5));

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools,
      service: stubService(),
      onEvent: async () => {},
      turnLogger: logger,
    });

    const toolResults = result.newMessages
      .filter((m) => m.role === "user")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_result");
    const byId = new Map(toolResults.map((r) => [(r as { toolUseId: string }).toolUseId, r]));
    expect(byId.get("t3")).toMatchObject({ isError: true });
    // search ran normally — not intercepted, not isError.
    const s1 = byId.get("s1");
    expect(s1).toBeDefined();
    expect((s1 as { isError?: boolean }).isError).toBeUndefined();
  });

  it("counter resets at turn boundary — each runStreamingAgentLoop invocation starts fresh", async () => {
    // Two sequential turns, each with 2 img calls. budget=2, so neither
    // turn trips the cluster. If the counter leaked across invocations,
    // the second turn's calls would intercept.
    const tools = new ToolRegistry();
    tools.register(budgetedTool("img", 2));

    const provider1 = mockStreamProvider([
      toolUseTurn("img", "ta", { q: "a" }),
      toolUseTurn("img", "tb", { q: "b" }),
      { events: [{ type: "text_delta", text: "done1" }], stopReason: "end_turn" },
    ]);
    const r1 = await runStreamingAgentLoop({
      provider: provider1,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools,
      service: stubService(),
      onEvent: async () => {},
      turnLogger: logger,
    });
    expect(r1.degraded).toBeUndefined();
    const r1Errors = r1.newMessages
      .filter((m) => m.role === "user")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_result" && "isError" in b && b.isError === true);
    expect(r1Errors).toHaveLength(0);

    const provider2 = mockStreamProvider([
      toolUseTurn("img", "tc", { q: "c" }),
      toolUseTurn("img", "td", { q: "d" }),
      { events: [{ type: "text_delta", text: "done2" }], stopReason: "end_turn" },
    ]);
    const r2 = await runStreamingAgentLoop({
      provider: provider2,
      model: "test",
      systemPrompt: "sys",
      // Fresh turn — caller does NOT carry the prior turn's tool_use
      // history into the new invocation. (Production passes only the
      // persisted messages; the loop scope is per-invocation.)
      messages: [{ role: "user", content: "go again" }],
      tools,
      service: stubService(),
      onEvent: async () => {},
      turnLogger: logger,
    });
    expect(r2.degraded).toBeUndefined();
    const r2Errors = r2.newMessages
      .filter((m) => m.role === "user")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_result" && "isError" in b && b.isError === true);
    expect(r2Errors).toHaveLength(0);
  });

  it("turn scope is initialLength-bounded — prior-turn tool_uses do not contribute to this turn's batch counter", async () => {
    // The turn-boundary test above proves the counter resets between
    // separate `runStreamingAgentLoop` invocations. This one pins a
    // related but distinct invariant: even when the caller seeds the
    // messages array with prior-turn tool_uses (e.g. recovering from a
    // persisted conversation), only the slice from `initialLength`
    // onward counts. Pre-seeded `img` tool_uses at indices 1 and 3
    // are BEFORE `initialLength` (= priorMessages.length = 6), so this
    // turn's first `img` call lands as batch 1, not batch 3.
    //
    // Inngest replay-safety follows from this purity property
    // (counter = pure function of (messages, initialLength)), but is
    // not directly simulated here; that would require an Inngest-style
    // function re-execution harness.
    const priorMessages: Message[] = [
      { role: "user", content: "earlier request" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "prior1", name: "img", input: { q: "p1" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "prior1", content: "ok" }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "prior2", name: "img", input: { q: "p2" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "prior2", content: "ok" }],
      },
      { role: "user", content: "now go" },
    ];

    const provider = mockStreamProvider([
      toolUseTurn("img", "new1", { q: "new" }),
      { events: [{ type: "text_delta", text: "done" }], stopReason: "end_turn" },
    ]);
    const tools = new ToolRegistry();
    tools.register(budgetedTool("img", 2));

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: priorMessages,
      tools,
      service: stubService(),
      onEvent: async () => {},
      turnLogger: logger,
    });

    // The fresh tool_use (new1) lands as the 3rd `img` call when counted
    // from the start of this turn's iteration window (initialLength =
    // priorMessages.length). Per the design, the counter scope is one
    // runStreamingAgentLoop invocation — prior messages from earlier
    // turns are NOT part of this turn's count. So new1 should be the
    // 1st of this turn and NOT intercepted.
    const toolResults = result.newMessages
      .filter((m) => m.role === "user")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_result");
    const new1 = toolResults.find((r) => (r as { toolUseId: string }).toolUseId === "new1");
    expect(new1).toBeDefined();
    expect((new1 as { isError?: boolean }).isError).toBeUndefined();
  });

  it("single iteration with N parallel calls is one batch — all admit regardless of N vs budget", async () => {
    // User-requested batch: "generate 10 images" in one shot. budget=2.
    // The model emits 10 parallel-safe img tool_uses in one iteration.
    // Per-batch counter: this is 1 batch (the model made one decision
    // to call img with 10 args). All 10 execute. The cluster trigger
    // targets the across-iteration decision loop, not within-iteration
    // parallelism.
    const parallelBlocks = Array.from({ length: 10 }, (_, i) => ({
      type: "tool_start" as const,
      id: `p${i + 1}`,
      name: "img",
      input: { q: `image ${i + 1}` },
    }));
    const provider = mockStreamProvider([
      { events: parallelBlocks, stopReason: "tool_use" },
      { events: [{ type: "text_delta", text: "done" }], stopReason: "end_turn" },
    ]);
    const tools = new ToolRegistry();
    tools.register(budgetedTool("img", 2));
    const turnLogger = mock<Logger>();

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "generate 10 images" }],
      tools,
      service: stubService(),
      onEvent: async () => {},
      turnLogger,
    });

    expect(result.degraded).toBeUndefined();
    const toolResults = result.newMessages
      .filter((m) => m.role === "user")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_result");
    expect(toolResults).toHaveLength(10);
    // All 10 ran — none have isError set.
    const errors = toolResults.filter(
      (r) => "isError" in r && (r as { isError?: boolean }).isError === true,
    );
    expect(errors).toHaveLength(0);
    // No volume_cluster telemetry — the batch was admitted.
    const volumeWarnings = turnLogger.warn.mock.calls.filter(
      (call) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        "subtype" in call[0] &&
        (call[0] as { subtype?: string }).subtype === "volume_cluster",
    );
    expect(volumeWarnings).toHaveLength(0);
  });

  it("parallel batch intercept: all blocks of the over-budget batch get the synthetic tool_result", async () => {
    // Two prior iterations consumed the budget (=2). A third iteration
    // emits 3 parallel calls — the WHOLE batch intercepts (all 3),
    // and the model receives three synthetic isError tool_results.
    const provider = mockStreamProvider([
      toolUseTurn("img", "t1", { q: "a" }),
      toolUseTurn("img", "t2", { q: "b" }),
      {
        events: [
          { type: "tool_start", id: "p1", name: "img", input: { q: "c" } },
          { type: "tool_start", id: "p2", name: "img", input: { q: "d" } },
          { type: "tool_start", id: "p3", name: "img", input: { q: "e" } },
        ],
        stopReason: "tool_use",
      },
      { events: [{ type: "text_delta", text: "done" }], stopReason: "end_turn" },
    ]);
    const tools = new ToolRegistry();
    tools.register(budgetedTool("img", 2));
    const turnLogger = mock<Logger>();

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools,
      service: stubService(),
      onEvent: async () => {},
      turnLogger,
    });

    expect(result.degraded).toBeUndefined();
    const toolResults = result.newMessages
      .filter((m) => m.role === "user")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_result");
    const byId = new Map(toolResults.map((r) => [(r as { toolUseId: string }).toolUseId, r]));
    expect((byId.get("t1") as { isError?: boolean }).isError).toBeUndefined();
    expect((byId.get("t2") as { isError?: boolean }).isError).toBeUndefined();
    // All three parallel blocks in the over-budget batch intercept.
    expect(byId.get("p1")).toMatchObject({ isError: true });
    expect(byId.get("p2")).toMatchObject({ isError: true });
    expect(byId.get("p3")).toMatchObject({ isError: true });
    // One telemetry emission for the whole batch (not three).
    const volumeWarnings = turnLogger.warn.mock.calls.filter(
      (call) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        "subtype" in call[0] &&
        (call[0] as { subtype?: string }).subtype === "volume_cluster",
    );
    expect(volumeWarnings).toHaveLength(1);
    expect(volumeWarnings[0]?.[0]).toMatchObject({
      tool: "img",
      batchCount: 3,
      callCount: 5,
      blocksInBatch: 3,
      budget: 2,
    });
  });

  it("composes with the fingerprint: cluster intercept → repeat-args → stuck_loop degrade", async () => {
    // budget=2 admits 2 calls of img(args=A). Iter 3 emits img(args=A)
    // again — INTERCEPTED (not executed). Iter 4 and 5 also emit
    // img(args=A) — also intercepted. The fingerprint sees three
    // consecutive iterations with the same (name, args) hash and no
    // side effect (intercepts are isError: true). consecutiveCount
    // reaches 3 and the loop degrades on stuck_loop.
    const provider = mockStreamProvider([
      toolUseTurn("img", "t1", { q: "same" }),
      toolUseTurn("img", "t2", { q: "same" }),
      toolUseTurn("img", "t3", { q: "same" }), // intercepted (count=3)
      toolUseTurn("img", "t4", { q: "same" }), // intercepted (count=4)
      toolUseTurn("img", "t5", { q: "same" }), // intercepted (count=5)
    ]);
    const tools = new ToolRegistry();
    // sideEffectful: true so the first two successful runs reset the
    // consecutive counter; once interception kicks in, all iterations
    // are isError: true → no side effect → fingerprint accumulates.
    tools.register(budgetedTool("img", 2, true));

    const result = await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools,
      service: stubService(),
      onEvent: async () => {},
      turnLogger: logger,
    });

    // Iterations 1, 2 succeed. Iter 3 intercept = no side effect, fp
    // consecutive=1. Iter 4 = consecutive=2. Iter 5 = consecutive=3
    // → stuck_loop trip.
    expect(result.degraded).toEqual({ reason: "stuck_loop", subtype: "stuck_loop" });
  });

  it("unknown tool falls through the existing unknown-tool error path (not budgeted)", async () => {
    // The interceptor doesn't try to budget tools it can't resolve — the
    // existing runOne unknown-tool error path handles them. A single
    // call to a non-registered tool returns the unknown-tool error
    // without any volume_cluster telemetry firing.
    const provider = mockStreamProvider([
      toolUseTurn("nope", "u1", { q: "x" }),
      { events: [{ type: "text_delta", text: "k" }], stopReason: "end_turn" },
    ]);
    const tools = new ToolRegistry(); // empty
    const turnLogger = mock<Logger>();

    await runStreamingAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools,
      service: stubService(),
      onEvent: async () => {},
      turnLogger,
    });

    const volumeWarnings = turnLogger.warn.mock.calls.filter(
      (call) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        "subtype" in call[0] &&
        (call[0] as { subtype?: string }).subtype === "volume_cluster",
    );
    expect(volumeWarnings).toHaveLength(0);
  });
});
