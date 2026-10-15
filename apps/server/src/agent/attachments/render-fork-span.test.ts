import { ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../llm/types.js";
import type { ImageRefBlock, StoredMessage } from "../stored-content.js";
import { renderForkSpan } from "./render-fork-span.js";

function image(path: string): ImageRefBlock {
  return {
    type: "image_ref",
    path,
    mediaType: "image/jpeg",
    width: 2000,
    height: 1500,
    bytes: 3_000_000,
    original: { path: `inbound/${path}`, mediaType: "image/jpeg" },
  };
}

const messages: StoredMessage[] = [
  { role: "user", content: [image("a.jpg")] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "a", signature: "s" },
      { type: "text", text: "A" },
    ],
  },
  { role: "user", content: [image("b.jpg")] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "b", signature: "s" },
      { type: "text", text: "B" },
    ],
  },
];
const messageIds = ["id-1", "id-2", "id-3", "id-4"];

function reader() {
  return { readBase64: vi.fn(async (path: string) => ok(Buffer.from(path).toString("base64"))) };
}

describe("renderForkSpan", () => {
  const sent: Message[] = [{ role: "user", content: "as the view sent it" }];

  it("sends the span as the view did when the summarization route's budget holds it", async () => {
    const read = reader();
    const span = await renderForkSpan(read, {
      messages,
      messageIds,
      cutoff: null,
      limits: { requestBytes: 32_000_000, images: 100 },
      sent,
    });
    expect(span).toEqual(sent);
    expect(read.readBase64).not.toHaveBeenCalled();
  });

  it("advances its own cutoff on a smaller budget and strips every thinking block", async () => {
    // 8 MB of base64 over a 20 MB route's 12 MB budget would fit; a 10 MB route's 2 MB doesn't.
    const span = await renderForkSpan(reader(), {
      messages,
      messageIds,
      cutoff: null,
      limits: { requestBytes: 10_000_000, images: 100 },
      sent,
    });
    expect(span.map((m) => m.content)).toEqual([
      [{ type: "text", text: "[Image: photo. Sent earlier and no longer attached.]" }],
      [{ type: "text", text: "A" }],
      [{ type: "text", text: "[Image: photo. Sent earlier and no longer attached.]" }],
      [{ type: "text", text: "B" }],
    ]);
  });

  it("renders under the conversation's cutoff outside a turn", async () => {
    const span = await renderForkSpan(reader(), {
      messages,
      messageIds,
      cutoff: "id-2",
      limits: { requestBytes: 32_000_000, images: 100 },
    });
    expect(span[0]?.content).toEqual([
      { type: "text", text: "[Image: photo. Sent earlier and no longer attached.]" },
    ]);
    expect(span[2]?.content).toEqual([
      expect.objectContaining({ type: "image", width: 2000, height: 1500 }),
    ]);
    expect(span[1]?.content).toEqual(messages[1]?.content);
  });
});
