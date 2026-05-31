import { describe, expect, it } from "vitest";
import type { Message } from "../llm/types.js";
import { validateHistory } from "./history-invariants.js";

function user(content: Message["content"]): Message {
  return { role: "user", content };
}

function assistant(content: Message["content"]): Message {
  return { role: "assistant", content };
}

describe("validateHistory", () => {
  it("passes a clean history through unchanged", () => {
    const input: Message[] = [
      user("hi"),
      assistant([{ type: "text", text: "hello" }]),
      user("again"),
    ];

    const result = validateHistory(input);
    expect(result.messages).toEqual(input);
    expect(result.repairs).toEqual([]);
  });

  it("passes a clean tool-call sequence unchanged", () => {
    const input: Message[] = [
      user("echo"),
      assistant([{ type: "tool_use", id: "t1", name: "echo", input: {} }]),
      user([{ type: "tool_result", toolUseId: "t1", content: "ok" }]),
      assistant([{ type: "text", text: "done" }]),
    ];

    const result = validateHistory(input);
    expect(result.messages).toEqual(input);
    expect(result.repairs).toEqual([]);
  });

  it("synthesizes a tool_result when assistant ends with an unanswered tool_use", () => {
    const input: Message[] = [
      user("go"),
      assistant([{ type: "tool_use", id: "t1", name: "echo", input: {} }]),
    ];

    const { messages, repairs } = validateHistory(input);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "t1",
          content: "tool execution did not complete (recovered)",
          isError: true,
        },
      ],
    });
    expect(repairs).toEqual([{ kind: "synthesized_tool_result", index: 1, toolUseId: "t1" }]);
  });

  // The exact orphan from the cogmo-tool-use-orphan.md report: assistant
  // emits only a tool_use, followed by a fresh user message. Before the fix,
  // sending this to Anthropic returned 400 every retry.
  it("repairs the orphan-tool_use → user-text bug from production", () => {
    const input: Message[] = [
      user("hi"),
      assistant([
        {
          type: "tool_use",
          id: "toolu_01Hmo6DdRdR2MuCUeUeJmqGm",
          name: "memory_retain",
          input: { content: "fact" },
        },
      ]),
      user("are you there?"),
    ];

    const { messages, repairs } = validateHistory(input);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "toolu_01Hmo6DdRdR2MuCUeUeJmqGm",
          content: "tool execution did not complete (recovered)",
          isError: true,
        },
        { type: "text", text: "are you there?" } as never,
      ],
    });
    expect(repairs).toEqual([
      {
        kind: "synthesized_tool_result",
        index: 1,
        toolUseId: "toolu_01Hmo6DdRdR2MuCUeUeJmqGm",
      },
    ]);
  });

  it("merges with the existing user message when next has partial tool_results", () => {
    const input: Message[] = [
      user("go"),
      assistant([
        { type: "tool_use", id: "t1", name: "a", input: {} },
        { type: "tool_use", id: "t2", name: "b", input: {} },
      ]),
      user([{ type: "tool_result", toolUseId: "t1", content: "ok-a" }]),
    ];

    const { messages, repairs } = validateHistory(input);
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "t2",
          content: "tool execution did not complete (recovered)",
          isError: true,
        },
        { type: "tool_result", toolUseId: "t1", content: "ok-a" },
      ],
    });
    expect(repairs).toEqual([{ kind: "synthesized_tool_result", index: 1, toolUseId: "t2" }]);
  });

  it("drops a stray tool_result that has no matching prior tool_use", () => {
    const input: Message[] = [
      user("hi"),
      assistant([{ type: "text", text: "hello" }]),
      user([
        { type: "tool_result", toolUseId: "ghost", content: "stray" },
        { type: "text", text: "real text" },
      ]),
    ];

    const { messages, repairs } = validateHistory(input);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "real text" }],
    });
    expect(repairs).toEqual([{ kind: "dropped_stray_tool_result", index: 2, toolUseId: "ghost" }]);
  });

  it("drops a user message that becomes empty after stripping strays", () => {
    const input: Message[] = [
      user("hi"),
      assistant([{ type: "text", text: "hello" }]),
      user([{ type: "tool_result", toolUseId: "ghost", content: "stray" }]),
    ];

    const { messages, repairs } = validateHistory(input);
    expect(messages).toHaveLength(2);
    expect(repairs).toEqual([
      { kind: "dropped_stray_tool_result", index: 2, toolUseId: "ghost" },
      { kind: "dropped_empty_message", index: 2 },
    ]);
  });

  it("drops messages with empty content", () => {
    const input: Message[] = [user(""), user("hi"), assistant([])];

    const { messages, repairs } = validateHistory(input);
    expect(messages).toEqual([user("hi")]);
    expect(repairs).toEqual([
      { kind: "dropped_empty_message", index: 0 },
      { kind: "dropped_empty_message", index: 2 },
    ]);
  });

  it("does not mutate the input array", () => {
    const input: Message[] = [
      user("go"),
      assistant([{ type: "tool_use", id: "t1", name: "echo", input: {} }]),
    ];
    const before = JSON.parse(JSON.stringify(input));
    validateHistory(input);
    expect(input).toEqual(before);
  });

  it("synthesizes for multiple tool_use ids in the same assistant message", () => {
    const input: Message[] = [
      user("go"),
      assistant([
        { type: "tool_use", id: "t1", name: "a", input: {} },
        { type: "tool_use", id: "t2", name: "b", input: {} },
        { type: "tool_use", id: "t3", name: "c", input: {} },
      ]),
    ];

    const { messages, repairs } = validateHistory(input);
    expect(messages).toHaveLength(3);
    expect(Array.isArray(messages[2]!.content)).toBe(true);
    const synthesized = messages[2]!.content as Array<{ toolUseId: string }>;
    expect(synthesized.map((b) => b.toolUseId)).toEqual(["t1", "t2", "t3"]);
    expect(repairs.map((r) => ("toolUseId" in r ? r.toolUseId : null))).toEqual(["t1", "t2", "t3"]);
  });

  it("does not flag a tool_result whose tool_use lives in the same loop earlier", () => {
    // Reflects the within-loop multi-round case after fix A — assistant
    // tool_use, user tool_result, assistant tool_use, user tool_result, ...
    const input: Message[] = [
      user("go"),
      assistant([{ type: "tool_use", id: "t1", name: "a", input: {} }]),
      user([{ type: "tool_result", toolUseId: "t1", content: "ok" }]),
      assistant([{ type: "tool_use", id: "t2", name: "b", input: {} }]),
      user([{ type: "tool_result", toolUseId: "t2", content: "ok" }]),
    ];

    const { messages, repairs } = validateHistory(input);
    expect(messages).toEqual(input);
    expect(repairs).toEqual([]);
  });

  it("handles assistant followed by another assistant (orphan, no answering user)", () => {
    const input: Message[] = [
      user("go"),
      assistant([{ type: "tool_use", id: "t1", name: "a", input: {} }]),
      assistant([{ type: "text", text: "i forgot" }]),
    ];

    const { messages, repairs } = validateHistory(input);
    // Synthetic user inserted between the two assistants
    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "t1",
          content: "tool execution did not complete (recovered)",
          isError: true,
        },
      ],
    });
    expect(messages[3]).toEqual(input[2]);
    expect(repairs).toEqual([{ kind: "synthesized_tool_result", index: 1, toolUseId: "t1" }]);
  });
});
