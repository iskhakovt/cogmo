import { describe, expect, it } from "vitest";
import type { TurnMessage } from "../../store/index.js";
import { quotesUser, renderContext, renderTurn } from "./turns.js";

const CURSOR = "cursor-1";
const PREVIOUS = "cursor-0";

const IMAGE = {
  type: "image_ref" as const,
  path: "a.png",
  mediaType: "image/png" as const,
  width: 1,
  height: 1,
  bytes: 1,
  original: { path: "a.png", mediaType: "image/png" },
};

let nextId = 0;
function row(
  role: "user" | "assistant",
  content: TurnMessage["content"],
  cursor = CURSOR,
): TurnMessage {
  nextId++;
  return { id: `msg-${nextId}`, role, content, cursor };
}

describe("renderTurn", () => {
  it("renders the turn's rows only, its newest turn row standing for a duplicate", () => {
    const rows = [
      row("user", "before", PREVIOUS),
      row("user", "first write"),
      row("user", "second write"),
      row("assistant", [
        { type: "text", text: "Looking." },
        { type: "tool_use", id: "t1", name: "web_search", input: { q: "x" } },
      ]),
      row("user", [{ type: "tool_result", toolUseId: "t1", content: "found" }]),
      row("assistant", "Here it is."),
    ];

    const turn = renderTurn(rows, CURSOR);

    expect(turn.transcript).toBe(
      'User: second write\n\nAssistant: Looking.\n[Tool: web_search({"q":"x"})]\n\nUser: → found\n\nAssistant: Here it is.',
    );
    expect(turn.userText).toBe("second write");
  });

  it("leaves forwarded text, image labels and attachment notes out of the user's text", () => {
    const rows = [
      row("user", [
        {
          type: "text",
          text: '<forwarded_message from="Ann" origin="user" sent="2026-10-01">\nCall me back\n</forwarded_message>',
        },
        { type: "text", text: "Image 1:", harness: "image_label" },
        { type: "text", text: "a voice note arrived", harness: "attachment_placeholder" },
        { type: "text", text: "Don't summarise forwards, quote them." },
      ]),
      row("assistant", "Noted."),
    ];

    expect(renderTurn(rows, CURSOR).userText).toBe("Don't summarise forwards, quote them.");
  });

  it("has no user text when the turn row holds none", () => {
    const rows = [row("user", [IMAGE]), row("assistant", "Nice photo.")];

    expect(renderTurn(rows, CURSOR).userText).toBe("");
  });
});

describe("renderContext", () => {
  it("keeps the earlier turn's user text and final reply, without its tool rounds", () => {
    const rows = [
      row("user", "What's the weather?", PREVIOUS),
      row(
        "assistant",
        [{ type: "tool_use", id: "t1", name: "web_search", input: { q: "weather" } }],
        PREVIOUS,
      ),
      row("user", [{ type: "tool_result", toolUseId: "t1", content: "sunny" }], PREVIOUS),
      row("assistant", "It's sunny, with a long explanation.", PREVIOUS),
      row("user", "Shorter please."),
    ];

    expect(renderContext(rows, PREVIOUS)).toBe(
      "User: What's the weather?\n\nAssistant: It's sunny, with a long explanation.",
    );
  });

  it("caps a long earlier message to its head and tail", () => {
    const long = `${"a".repeat(2000)}${"z".repeat(2000)}`;
    const rows = [row("user", "go", PREVIOUS), row("assistant", long, PREVIOUS)];

    const context = renderContext(rows, PREVIOUS);

    expect(context.length).toBeLessThan(1700);
    expect(context).toContain("characters truncated]");
    expect(context.endsWith("zzz")).toBe(true);
  });
});

describe("quotesUser", () => {
  const said = "Please,   don’t use bullet points with me.\nJust write plainly.";

  it("finds a quote across case, whitespace and curly quotes", () => {
    expect(quotesUser("DON'T use bullet points", said)).toBe(true);
    expect(quotesUser('"don\'t use bullet points with me. just write"', said)).toBe(true);
    expect(quotesUser("…bullet points…", said)).toBe(true);
  });

  it("refuses a paraphrase, and an empty quote", () => {
    expect(quotesUser("no bullets", said)).toBe(false);
    expect(quotesUser('""', said)).toBe(false);
    expect(quotesUser("", said)).toBe(false);
  });
});
