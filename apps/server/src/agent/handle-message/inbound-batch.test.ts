import { describe, expect, it } from "vitest";
import {
  batchCursors,
  type InboundRow,
  renderUserContent,
  routingKindOf,
  substituteTranscripts,
} from "./inbound-batch.js";

function row(id: string, content: InboundRow["content"], source: InboundRow["source"] = "user") {
  return { id, content, source } satisfies InboundRow;
}

const FORWARDED = { origin: "user", from: "Ann", sentAt: "2026-01-01T00:00:00.000Z" } as const;

describe("batchCursors", () => {
  it("takes the last inbound as the cursor and the first as the turn token", () => {
    expect(batchCursors([row("a", "x"), row("b", "y"), row("c", "z")])).toEqual({
      maxInboundId: "c",
      firstInboundId: "a",
    });
  });

  it("returns empty ids for an empty batch", () => {
    expect(batchCursors([])).toEqual({ maxInboundId: "", firstInboundId: "" });
  });
});

describe("routingKindOf", () => {
  it("replies to a user batch", () => {
    expect(routingKindOf("conv", [row("a", "x"), row("b", "y")])).toBe("reply");
  });

  it("broadcasts a scheduled batch", () => {
    expect(routingKindOf("conv", [row("a", "x", "scheduled")])).toBe("broadcast");
  });

  it("refuses a batch that mixes user and scheduled rows", () => {
    expect(() => routingKindOf("conv", [row("a", "x"), row("b", "y", "scheduled")])).toThrow(
      "mixed-source inbound batch in conversation conv: 1/2 scheduled",
    );
  });
});

describe("substituteTranscripts", () => {
  it("replaces each voice block with its transcript, in inbound order", () => {
    const voice = { type: "voice", path: "v", mediaType: "audio/ogg" } as const;
    const substituted = substituteTranscripts(
      [row("a", [voice]), row("b", "typed"), row("c", [{ type: "text", text: "hi" }, voice])],
      ["first", "second"],
    );
    expect(substituted).toEqual([
      { content: [{ type: "text", text: "first" }] },
      { content: "typed" },
      {
        content: [
          { type: "text", text: "hi" },
          { type: "text", text: "second" },
        ],
      },
    ]);
  });

  it("keeps a forwarded clip's marking on its transcript", () => {
    const substituted = substituteTranscripts(
      [row("a", [{ type: "voice", path: "v", mediaType: "audio/ogg", forwarded: FORWARDED }])],
      ["said"],
    );
    expect(substituted).toEqual([
      { content: [{ type: "text", text: "said", forwarded: FORWARDED }] },
    ]);
  });
});

describe("renderUserContent", () => {
  it("joins text-only rows on newlines", () => {
    expect(
      renderUserContent([
        { content: "one" },
        {
          content: [
            { type: "text", text: "two" },
            { type: "text", text: "three" },
          ],
        },
      ]),
    ).toBe("one\ntwo\nthree");
  });

  it("renders forwarded text inside its element", () => {
    const rendered = renderUserContent([
      { content: [{ type: "text", text: "quoted", forwarded: FORWARDED }] },
    ]);
    expect(rendered).toContain("<forwarded_message");
    expect(rendered).toContain("quoted");
  });

  it("JSON-stringifies a row that still carries an attachment", () => {
    const content = [
      { type: "text", text: "look" },
      { type: "image", path: "p", mediaType: "image/png" },
    ] as const;
    expect(renderUserContent([{ content: [...content] }])).toBe(JSON.stringify(content));
  });
});
