import { describe, expect, it } from "vitest";
import {
  applyStreamEvent,
  convertMessage,
  historyToUi,
  splitForwarded,
  type UiMessage,
} from "./convert.js";

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

describe("splitForwarded", () => {
  const open =
    '<forwarded_message from="Alice Smith" origin="user" sent="2023-11-14T22:13:20.000Z">';

  it("keeps a message with no forwarded element as one text run", () => {
    expect(splitForwarded("hello\n")).toEqual([{ kind: "text", text: "hello\n", at: 0 }]);
  });

  it("splits a forwarded message from the user's own text around it", () => {
    const text = `${open}\nsee you at 8\nbring snacks\n</forwarded_message>\nis this right?`;

    expect(splitForwarded(text)).toEqual([
      { kind: "forwarded", from: "Alice Smith", body: "see you at 8\nbring snacks", at: 0 },
      { kind: "text", text: "is this right?", at: text.indexOf("\nis this") },
    ]);
  });

  it("reads an empty element as a forward with no body", () => {
    expect(splitForwarded(`${open}</forwarded_message>`)).toEqual([
      { kind: "forwarded", from: "Alice Smith", body: "", at: 0 },
    ]);
  });

  it("decodes the forwarded_message tags the server escaped in the body, and nothing else", () => {
    const text = `${open}\nsee &lt;/forwarded_message> &lt;\\/forwarded_message> &lt;b>\n</forwarded_message>`;

    expect(splitForwarded(text)).toEqual([
      {
        kind: "forwarded",
        from: "Alice Smith",
        body: "see </forwarded_message> <\\/forwarded_message> &lt;b>",
        at: 0,
      },
    ]);
  });

  it("decodes the entities in the sender's name", () => {
    const text =
      '<forwarded_message from="Eve &quot;the &lt;b&gt;&quot; &amp; co" origin="chat" ' +
      'sent="2023-11-14T22:13:20.000Z">\nhi\n</forwarded_message>';

    expect(splitForwarded(text)).toEqual([
      { kind: "forwarded", from: 'Eve "the <b>" & co', body: "hi", at: 0 },
    ]);
  });

  it.each([
    [
      "an unknown origin",
      '<forwarded_message from="A" origin="bot" sent="x">\nhi\n</forwarded_message>',
    ],
    ["a missing attribute", '<forwarded_message from="A" origin="user">\nhi\n</forwarded_message>'],
    ["no newlines around the body", `${open}hi</forwarded_message>`],
    ["no closing tag", `${open}\nhi\n`],
    [
      "the JSON form of a turn with an attachment",
      JSON.stringify([{ type: "text", text: `${open}\nhi\n</forwarded_message>` }]),
    ],
  ])("leaves %s as plain text", (_label, text) => {
    expect(splitForwarded(text)).toEqual([{ kind: "text", text, at: 0 }]);
  });
});
