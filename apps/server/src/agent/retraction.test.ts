import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Message } from "../llm/types.js";
import { computeRetraction } from "./retraction.js";

const toolTurn: Message[] = [
  {
    role: "assistant",
    content: [
      { type: "text", text: "Let me check. " },
      { type: "tool_use", id: "t1", name: "echo", input: {} },
    ],
  },
  { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }] },
];

describe("computeRetraction", () => {
  it("names only the dropped tail: its text and its tool calls", () => {
    const retraction = computeRetraction(
      { text: "Let me check. Writing it now.", toolUseIds: ["t1", "t2"] },
      toolTurn,
      mock<Logger>(),
    );
    expect(retraction).toEqual({ text: "Writing it now.", toolUseIds: ["t2"] });
  });

  it("returns null when everything streamed is persisted", () => {
    expect(
      computeRetraction({ text: "Let me check. ", toolUseIds: ["t1"] }, toolTurn, mock<Logger>()),
    ).toBeNull();
  });

  it("retracts no text, only tool cards, when the persisted text never streamed", () => {
    // The non-streaming replay persists content whose deltas it didn't emit.
    const log = mock<Logger>();
    const retraction = computeRetraction(
      { text: "Something else entirely", toolUseIds: ["t1", "t2"] },
      toolTurn,
      log,
    );
    expect(retraction).toEqual({ text: "", toolUseIds: ["t2"] });
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("reads string content as persisted text", () => {
    expect(
      computeRetraction(
        { text: "Hello there", toolUseIds: [] },
        [{ role: "assistant", content: "Hello" }],
        mock<Logger>(),
      ),
    ).toEqual({ text: " there", toolUseIds: [] });
  });
});
