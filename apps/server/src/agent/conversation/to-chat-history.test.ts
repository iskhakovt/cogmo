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
      { id: "m1", role: "user", text: "hello", attachments: [] },
      { id: "m2", role: "assistant", text: "hi there", attachments: [] },
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
      { id: "m1", role: "user", text: "hello", attachments: [] },
      { id: "m3", role: "assistant", text: `Partial${notice}`, attachments: [] },
    ]);
  });

  it("keeps an image-only message with its attachments and shows placeholders as notes", () => {
    expect(
      toChatHistory([
        {
          id: "m1",
          role: "user",
          content: [
            { type: "text", text: "Image 1: normalized/a.jpg (cat.jpg)", harness: "image_label" },
            {
              type: "image_ref",
              path: "normalized/a.jpg",
              mediaType: "image/jpeg",
              width: 2000,
              height: 1500,
              bytes: 1,
              name: "cat.jpg",
              original: { path: "inbound/a.heic", mediaType: "image/heic" },
            },
            {
              type: "document_ref",
              path: "inbound/r.pdf",
              mediaType: "application/pdf",
              name: "r.pdf",
              bytes: 1,
            },
            { type: "text", text: "[photo: too large]", harness: "attachment_placeholder" },
          ],
        },
      ]),
    ).toEqual([
      {
        id: "m1",
        role: "user",
        text: "",
        attachments: [
          { kind: "image", name: "cat.jpg", mediaType: "image/heic" },
          { kind: "document", name: "r.pdf", mediaType: "application/pdf" },
          { kind: "placeholder", text: "[photo: too large]" },
        ],
      },
    ]);
  });
});
