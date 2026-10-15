import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { AttachmentUnreadable } from "../../transport/attachment-store.js";
import type { DocumentRefBlock, ImageRefBlock, StoredMessage } from "../stored-content.js";
import type { AttachmentReader } from "./attachment-reader.js";
import {
  RENDERER_PLACEHOLDERS,
  renderStoredContent,
  renderStoredMessages,
} from "./render-stored-content.js";

const photo: ImageRefBlock = {
  type: "image_ref",
  path: "normalized/a.jpg",
  mediaType: "image/jpeg",
  width: 2000,
  height: 1500,
  bytes: 6,
  original: { path: "inbound/a.heic", mediaType: "image/heic" },
};

const report: DocumentRefBlock = {
  type: "document_ref",
  path: "inbound/r.pdf",
  mediaType: "application/pdf",
  name: "report.pdf",
  bytes: 3,
};

function reader(
  objects: Record<string, Buffer | AttachmentUnreadable>,
): AttachmentReader & { readBase64: ReturnType<typeof vi.fn> } {
  return {
    readBase64: vi.fn(async (path: string) => {
      const object = objects[path];
      if (object === undefined) throw new Error(`transient: ${path}`);
      return Buffer.isBuffer(object) ? ok(object.toString("base64")) : err(object);
    }),
  };
}

describe("renderStoredContent", () => {
  it("resolves an image ref to base64 carrying its dimensions", async () => {
    const content = await renderStoredContent(
      [{ type: "text", text: "Image 1: normalized/a.jpg", harness: "image_label" }, photo],
      reader({ "normalized/a.jpg": Buffer.from("pixels") }),
      false,
    );
    expect(content).toEqual([
      { type: "text", text: "Image 1: normalized/a.jpg", harness: "image_label" },
      {
        type: "image",
        source: "base64",
        data: Buffer.from("pixels").toString("base64"),
        mediaType: "image/jpeg",
        width: 2000,
        height: 1500,
      },
    ]);
  });

  it("resolves a document ref to a named base64 document", async () => {
    const content = await renderStoredContent(
      [report],
      reader({ "inbound/r.pdf": Buffer.from("%PDF") }),
      false,
    );
    expect(content).toEqual([
      {
        type: "document",
        source: "base64",
        data: Buffer.from("%PDF").toString("base64"),
        mediaType: "application/pdf",
        name: "report.pdf",
      },
    ]);
  });

  it("renders a ref at or before the cutoff as a placeholder naming the file, unread", async () => {
    const read = reader({});
    const content = await renderStoredContent([photo, report], read, true);
    expect(content).toEqual([
      { type: "text", text: "[Image: photo. Sent earlier and no longer attached.]" },
      { type: "text", text: "[Document: report.pdf. Sent earlier and no longer attached.]" },
    ]);
    expect(read.readBase64).not.toHaveBeenCalled();
  });

  it("renders a permanently unreadable object as a placeholder", async () => {
    const content = await renderStoredContent(
      [{ ...photo, name: "cat.jpg" }],
      reader({ "normalized/a.jpg": { kind: "missing" } }),
      false,
    );
    expect(content).toEqual([
      { type: "text", text: "[Image: cat.jpg. The stored file could not be read.]" },
    ]);
  });

  it("throws on a transient read failure, so a retry renders the same request", async () => {
    await expect(renderStoredContent([photo], reader({}), false)).rejects.toThrow("transient");
  });

  it("passes a string row through unchanged", async () => {
    const legacy = JSON.stringify([
      { type: "image", path: "inbound/x.jpg", mediaType: "image/jpeg" },
    ]);
    expect(await renderStoredContent(legacy, reader({}), true)).toBe(legacy);
  });
});

describe("renderStoredMessages", () => {
  it("applies the cutoff by row id, inclusive, and never to the summary entry", async () => {
    const rows: StoredMessage[] = [
      { role: "user", content: "[Previous conversation summary]\n\n…" },
      { role: "user", content: [photo] },
      { role: "user", content: [report] },
    ];
    const messages = await renderStoredMessages(
      rows,
      [null, "01900000-0000-7000-8000-000000000001", "01900000-0000-7000-8000-000000000002"],
      reader({ "inbound/r.pdf": Buffer.from("%PDF") }),
      "01900000-0000-7000-8000-000000000001",
    );
    expect(messages.map((m) => m.content)).toEqual([
      "[Previous conversation summary]\n\n…",
      [{ type: "text", text: "[Image: photo. Sent earlier and no longer attached.]" }],
      [expect.objectContaining({ type: "document", name: "report.pdf" })],
    ]);
  });
});

describe("RENDERER_PLACEHOLDERS", () => {
  it("pins the wording the configuration digest covers", () => {
    expect(JSON.parse(RENDERER_PLACEHOLDERS)).toEqual([
      "[Image: {name}. Sent earlier and no longer attached.]",
      "[Document: {name}. Sent earlier and no longer attached.]",
      "[Image: {name}. The stored file could not be read.]",
      "[Document: {name}. The stored file could not be read.]",
      "[Image: {name}. The model provider refused this file; ask for it another way.]",
      "[Document: {name}. The model provider refused this file; ask for it another way.]",
    ]);
  });
});
