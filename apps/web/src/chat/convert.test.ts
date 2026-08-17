import { describe, expect, it } from "vitest";
import { applyStreamEvent, convertMessage, historyToUi, type UiMessage } from "./convert.js";

const assistant: UiMessage = { id: "a1", role: "assistant", text: "", tools: [] };

describe("applyStreamEvent", () => {
  it("accumulates text deltas", () => {
    let m = applyStreamEvent(assistant, { type: "text_delta", text: "Hel" });
    m = applyStreamEvent(m, { type: "text_delta", text: "lo" });
    expect(m.text).toBe("Hello");
  });

  it("adds a tool on tool_start and pairs the result to the most recent unresolved tool of that name", () => {
    let m = applyStreamEvent(assistant, {
      type: "tool_start",
      id: "t1",
      name: "search",
      input: { q: "x" },
    });
    m = applyStreamEvent(m, { type: "tool_start", id: "t2", name: "search", input: { q: "y" } });
    m = applyStreamEvent(m, {
      type: "tool_result",
      name: "search",
      output: "found",
      isError: false,
    });
    expect(m.tools).toEqual([
      { id: "t1", name: "search", args: { q: "x" } },
      { id: "t2", name: "search", args: { q: "y" }, result: "found", isError: false },
    ]);
  });

  it("ignores thinking and status events (same reference back)", () => {
    expect(
      applyStreamEvent(assistant, { type: "thinking_delta", thinking: "h", signature: "s" }),
    ).toBe(assistant);
    expect(applyStreamEvent(assistant, { type: "status", message: "working" })).toBe(assistant);
  });

  it("drops the retracted text and tool cards, keeping what the turn persists", () => {
    // A multi-iteration turn: `search` ran to completion and is in the turn's
    // persisted messages, so its card and the narration around it stay. The
    // degrade-triggering iteration's fragment and its never-executed `fetch`
    // call are named by the retraction and go.
    let m = applyStreamEvent(assistant, { type: "text_delta", text: "Let me look that up. " });
    m = applyStreamEvent(m, { type: "tool_start", id: "t1", name: "search", input: {} });
    m = applyStreamEvent(m, { type: "tool_result", name: "search", output: "found" });
    m = applyStreamEvent(m, { type: "text_delta", text: "the three points are: (1) the dep" });
    m = applyStreamEvent(m, { type: "tool_start", id: "t2", name: "fetch", input: {} });
    m = applyStreamEvent(m, {
      type: "retract",
      text: "the three points are: (1) the dep",
      toolUseIds: ["t2"],
    });
    m = applyStreamEvent(m, { type: "text_delta", text: "This conversation is too long." });
    expect(m.text).toBe("Let me look that up. This conversation is too long.");
    expect(m.tools).toEqual([{ id: "t1", name: "search", args: {}, result: "found" }]);
  });

  it("retracts nothing on an empty retraction", () => {
    // The orchestrator sends no text when the streamed and persisted text
    // can't be lined up (the non-streaming replay path), and no ids when the
    // dropped iteration issued no tool calls.
    let m = applyStreamEvent(assistant, { type: "text_delta", text: "partial answer" });
    m = applyStreamEvent(m, { type: "tool_start", id: "t1", name: "search", input: {} });
    m = applyStreamEvent(m, { type: "retract", text: "", toolUseIds: [] });
    expect(m.text).toBe("partial answer");
    expect(m.tools).toEqual([{ id: "t1", name: "search", args: {} }]);
  });

  it("drops a tool_result with no matching pending tool", () => {
    const m = applyStreamEvent(assistant, { type: "tool_result", name: "nope", output: "x" });
    expect(m.tools).toEqual([]);
  });
});

describe("convertMessage", () => {
  it("maps text + a completed tool call to assistant-ui parts", () => {
    const msg: UiMessage = {
      id: "a1",
      role: "assistant",
      text: "done",
      tools: [{ id: "t1", name: "search", args: { q: "x" }, result: "r", isError: false }],
    };
    expect(convertMessage(msg)).toEqual({
      id: "a1",
      role: "assistant",
      content: [
        { type: "text", text: "done" },
        {
          type: "tool-call",
          toolCallId: "t1",
          toolName: "search",
          argsText: JSON.stringify({ q: "x" }),
          result: "r",
          isError: false,
        },
      ],
    });
  });

  it("omits result/isError while a tool is still running", () => {
    const msg: UiMessage = {
      id: "a1",
      role: "assistant",
      text: "",
      tools: [{ id: "t1", name: "x", args: {} }],
    };
    expect(convertMessage(msg)).toEqual({
      id: "a1",
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "t1", toolName: "x", argsText: "{}" }],
    });
  });

  it("falls back to an empty text part when there's no content", () => {
    expect(convertMessage(assistant)).toEqual({
      id: "a1",
      role: "assistant",
      content: [{ type: "text", text: "" }],
    });
  });
});

describe("historyToUi", () => {
  it("maps a history turn to a tool-less ui message", () => {
    expect(historyToUi({ id: "m1", role: "user", text: "hi" })).toEqual({
      id: "m1",
      role: "user",
      text: "hi",
      tools: [],
    });
  });
});
