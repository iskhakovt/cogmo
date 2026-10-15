import { describe, expect, it } from "vitest";
import type { ImageRefBlock, StoredMessage } from "../stored-content.js";
import { attachmentLoad, fixAttachmentCutoff } from "./attachment-cutoff.js";

function image(path: string, bytes: number): ImageRefBlock {
  return {
    type: "image_ref",
    path,
    mediaType: "image/jpeg",
    width: 2000,
    height: 1500,
    bytes,
    original: { path: `inbound/${path}`, mediaType: "image/jpeg" },
  };
}

function photoRow(path: string, bytes: number): StoredMessage {
  return { role: "user", content: [image(path, bytes), { type: "text", text: "look" }] };
}

const reply: StoredMessage = { role: "assistant", content: "nice" };

/** Six image turns of 3,000,000 bytes (4,000,000 as base64), then the turn's own text row. */
function sixPhotos(): { messages: StoredMessage[]; messageIds: string[] } {
  const messages: StoredMessage[] = [];
  const messageIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    messages.push(photoRow(`normalized/${i}.jpg`, 3_000_000), reply);
    messageIds.push(
      `0000000${i}-0000-7000-8000-000000000000`,
      `0000000${i}-0000-7000-8000-000000000001`,
    );
  }
  messages.push({ role: "user", content: "and now?" });
  messageIds.push("00000009-0000-7000-8000-000000000000");
  return { messages, messageIds };
}

describe("attachmentLoad", () => {
  it("counts each ref at its base64 size and each image once", () => {
    const load = attachmentLoad({
      role: "user",
      content: [
        image("a.jpg", 3),
        image("b.jpg", 4),
        {
          type: "document_ref",
          path: "d.pdf",
          mediaType: "application/pdf",
          name: "d.pdf",
          bytes: 10,
        },
      ],
    });
    expect(load).toEqual({ bytes: 4 + 8 + 16, images: 2 });
  });

  it("counts nothing in a string row", () => {
    expect(attachmentLoad({ role: "user", content: '[{"type":"image"}]' })).toEqual({
      bytes: 0,
      images: 0,
    });
  });
});

describe("fixAttachmentCutoff", () => {
  const none = { bytes: 0, images: 0 };

  it("keeps the epoch's cutoff while the view fits the budget", () => {
    const { messages, messageIds } = sixPhotos();
    expect(
      fixAttachmentCutoff({
        messages,
        messageIds,
        end: messages.length - 1,
        current: null,
        budget: { bytes: 24_000_000, images: 100 },
        extra: none,
      }),
    ).toEqual({ cutoff: null, advanced: false });
  });

  it("advances oldest first until the view is within half the budget", () => {
    const { messages, messageIds } = sixPhotos();
    // 24 MB of base64 over a 20 MB budget: cut to 10 MB or less, so four photos go.
    const fixed = fixAttachmentCutoff({
      messages,
      messageIds,
      end: messages.length - 1,
      current: null,
      budget: { bytes: 20_000_000, images: 100 },
      extra: none,
    });
    expect(fixed).toEqual({ cutoff: messageIds[6], advanced: true });
  });

  it("advances on the image count as well as bytes", () => {
    const { messages, messageIds } = sixPhotos();
    const fixed = fixAttachmentCutoff({
      messages,
      messageIds,
      end: messages.length - 1,
      current: null,
      budget: { bytes: 100_000_000, images: 4 },
      extra: none,
    });
    // Six images over four: cut to two.
    expect(fixed).toEqual({ cutoff: messageIds[6], advanced: true });
  });

  it("counts nothing at or before the epoch's cutoff, so later turns of the epoch keep it", () => {
    const { messages, messageIds } = sixPhotos();
    const budget = { bytes: 20_000_000, images: 100 };
    const first = fixAttachmentCutoff({
      messages,
      messageIds,
      end: messages.length - 1,
      current: null,
      budget,
      extra: none,
    });
    const next = fixAttachmentCutoff({
      messages,
      messageIds,
      end: messages.length - 1,
      current: first.cutoff,
      budget,
      extra: none,
    });
    expect(next).toEqual({ cutoff: first.cutoff, advanced: false });
  });

  it("never cuts the turn's own row or past it", () => {
    const { messages, messageIds } = sixPhotos();
    const fixed = fixAttachmentCutoff({
      messages,
      messageIds,
      end: 2,
      current: null,
      budget: { bytes: 4_000_000, images: 100 },
      extra: none,
    });
    expect(fixed).toEqual({ cutoff: messageIds[1], advanced: true });
  });

  it("counts what no ref records, a JSON-string turn's resolved attachments", () => {
    const { messages, messageIds } = sixPhotos();
    const fixed = fixAttachmentCutoff({
      messages,
      messageIds,
      end: messages.length - 1,
      current: null,
      budget: { bytes: 24_000_000, images: 100 },
      extra: { bytes: 1, images: 0 },
    });
    expect(fixed.advanced).toBe(true);
  });

  it("skips the synthetic summary entry", () => {
    const { messages, messageIds } = sixPhotos();
    const fixed = fixAttachmentCutoff({
      messages: [{ role: "user", content: "[Previous conversation summary]\n\n…" }, ...messages],
      messageIds: [null, ...messageIds],
      end: messages.length,
      current: null,
      budget: { bytes: 20_000_000, images: 100 },
      extra: none,
    });
    expect(fixed).toEqual({ cutoff: messageIds[6], advanced: true });
  });
});
