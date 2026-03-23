import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../llm/provider.js";
import type { LlmResponse } from "../llm/types.js";
import { runAgentLoop } from "./loop.js";
import { ToolRegistry } from "./tools.js";

function mockProvider(responses: LlmResponse[]): LlmProvider {
  const chat = vi.fn();
  for (const r of responses) {
    chat.mockResolvedValueOnce(r);
  }
  return { name: "mock", chat };
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
    tools.register("echo", "echoes", { type: "object" }, async (input) => {
      return `pong from ${(input as { text: string }).text}`;
    });

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
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

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
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
    tools.register("fail_tool", "always fails", { type: "object" }, async () => {
      throw new Error("boom");
    });

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
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
    tools.register("a", "a", { type: "object" }, async () => "result-a");
    tools.register("b", "b", { type: "object" }, async () => "result-b");

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
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
    tools.register("echo", "echo", { type: "object" }, async () => "ok");

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "loop" }],
      tools,
      maxIterations: 2,
    });

    expect(result.iterations).toBe(2);
    expect(provider.chat).toHaveBeenCalledTimes(2);
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
    });

    expect(original).toHaveLength(1);
  });
});
