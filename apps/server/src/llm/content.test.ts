import { describe, expect, it } from "vitest";
import { extractText } from "./content.js";

describe("extractText", () => {
  it("returns string content unchanged", () => {
    expect(extractText("  plain reply\n")).toBe("  plain reply\n");
  });

  it("concatenates text blocks verbatim, with no separator of its own", () => {
    expect(
      extractText([
        { type: "text", text: "Step one. " },
        { type: "text", text: "Step two.\n\n" },
        { type: "text", text: "[cut off]" },
      ]),
    ).toBe("Step one. Step two.\n\n[cut off]");
  });

  it("skips every non-text block", () => {
    expect(
      extractText([
        { type: "thinking", thinking: "plan", signature: "sig" },
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "t1", name: "echo", input: {} },
        { type: "tool_result", toolUseId: "t1", content: "not prose" },
      ]),
    ).toBe("Checking.");
  });

  it("returns an empty string when there is no text", () => {
    expect(extractText([])).toBe("");
    expect(extractText([{ type: "tool_use", id: "t1", name: "echo", input: {} }])).toBe("");
  });
});
