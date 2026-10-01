import { describe, expect, it } from "vitest";
import { toChatHistory } from "./to-chat-history.js";

describe("toChatHistory", () => {
  it("flattens content to text and drops tool-only turns", () => {
    expect(
      toChatHistory([
        { id: "m1", role: "user", content: "hello" },
        {
          id: "m2",
          role: "assistant",
          content: [
            { type: "text", text: "hi " },
            { type: "text", text: "there" },
          ],
        },
        {
          id: "m3",
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
        },
        {
          id: "m4",
          role: "user",
          content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }],
        },
      ]),
    ).toEqual([
      { id: "m1", role: "user", text: "hello" },
      { id: "m2", role: "assistant", text: "hi there" },
    ]);
  });

  it("drops the continuation prompt and keeps the truncation notice", () => {
    const notice = "\n\n[Reply cut off: it reached the model's output limit.]";
    expect(
      toChatHistory([
        { id: "m1", role: "user", content: "hello" },
        {
          id: "m2",
          role: "user",
          content: [
            { type: "text", text: "Please complete your response.", harness: "continuation" },
          ],
        },
        {
          id: "m3",
          role: "assistant",
          content: [
            { type: "text", text: "Partial" },
            { type: "text", text: notice, harness: "truncation_notice" },
          ],
        },
      ]),
    ).toEqual([
      { id: "m1", role: "user", text: "hello" },
      { id: "m3", role: "assistant", text: `Partial${notice}` },
    ]);
  });
});
