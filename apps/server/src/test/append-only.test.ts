import { describe, expect, it } from "vitest";
import { assertAppendOnly, compareRequests } from "./append-only.js";

const MARK = { type: "ephemeral", ttl: "1h" };

function request(messages: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-sonnet-5",
    system: [{ type: "text", text: "You are helpful.", cache_control: MARK }],
    tools: [
      { name: "a", input_schema: { type: "object" } },
      { name: "b", input_schema: { type: "object" }, cache_control: MARK },
    ],
    messages,
    cache_control: MARK,
    ...overrides,
  };
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const toolTurn = [
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "s" },
      { type: "tool_use", id: "t1", name: "a", input: { alpha: 1, zeta: 2 } },
      { type: "tool_use", id: "t2", name: "a", input: { alpha: 3, zeta: 4 } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "one" },
      { type: "tool_result", tool_use_id: "t2", content: "two" },
    ],
  },
];

describe("compareRequests", () => {
  it("passes a request that extends the previous one, counting runs of tool blocks once", () => {
    const prev = request([user("hi")]);
    const next = request([user("hi"), ...toolTurn]);

    // thinking + a tool_use run, then a tool_result run.
    expect(compareRequests(prev, next)).toEqual({ divergence: null, appended: 3 });
    expect(() => assertAppendOnly(prev, next)).not.toThrow();
  });

  it("ignores where the cache markers sit", () => {
    const prev = request([user("hi")]);
    const next = request(
      [{ role: "user", content: [{ type: "text", text: "hi", cache_control: MARK }] }],
      {
        tools: [
          { name: "a", input_schema: { type: "object" }, cache_control: MARK },
          { name: "b", input_schema: { type: "object" } },
        ],
      },
    );
    expect(compareRequests(prev, next).divergence).toBeNull();
  });

  it("names the system prompt when it changed", () => {
    const next = request([user("hi"), user("again")], {
      system: [{ type: "text", text: "You are helpful.\n\nCurrent time: 09:15" }],
    });
    expect(compareRequests(request([user("hi")]), next).divergence).toBe("system[0].text");
  });

  it("names a changed tool", () => {
    const next = request([user("hi")], {
      tools: [
        { name: "a", input_schema: { type: "object" } },
        { name: "c", input_schema: { type: "object" } },
      ],
    });
    expect(compareRequests(request([user("hi")]), next).divergence).toBe("tools[1].name");
  });

  it("names a reordered tool input down to the key", () => {
    const [assistant, results] = toolTurn;
    const reordered = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "tool_use", id: "t1", name: "a", input: { zeta: 2, alpha: 1 } },
        { type: "tool_use", id: "t2", name: "a", input: { alpha: 3, zeta: 4 } },
      ],
    };
    const prev = request([user("hi"), assistant, results]);
    const next = request([user("hi"), reordered, results, user("more")]);
    expect(compareRequests(prev, next).divergence).toBe("messages[1].content[1].input.alpha");
  });

  it("names a message the later request dropped or rewrote", () => {
    const prev = request([user("hi"), { role: "assistant", content: "hello" }, user("next")]);
    expect(compareRequests(prev, request([user("hi")])).divergence).toBe("messages[1]");
    expect(
      compareRequests(
        prev,
        request([user("hi"), { role: "assistant", content: "hi!" }, user("next")]),
      ).divergence,
    ).toBe("messages[1].content");
  });

  it("covers an OpenAI-shaped body, whose system prompt is its first message", () => {
    const system = (text: string) => ({ role: "system", content: text });
    const prev = { model: "m", messages: [system("sys"), { role: "user", content: "hi" }] };
    const next = { model: "m", messages: [system("sys, 09:15"), { role: "user", content: "hi" }] };
    expect(compareRequests(prev, next).divergence).toBe("messages[0].content");
  });

  it("fails a request that appends past the lookback window", () => {
    const many = Array.from({ length: 21 }, (_, i) => user(`m${i}`));
    expect(() => assertAppendOnly(request([]), request(many))).toThrow(/21 positions/);
  });

  it("reports the divergence when asserting", () => {
    const next = request([user("hi")], { system: [{ type: "text", text: "changed" }] });
    expect(() => assertAppendOnly(request([user("hi")]), next)).toThrow(/at system\[0\]\.text/);
  });
});
