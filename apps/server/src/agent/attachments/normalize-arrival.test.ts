import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { mockAttachmentStore } from "../../test/factories.js";
import type {
  FinishedOriginal,
  NormalizedImageResult,
} from "../../transport/attachment-original.js";
import { type InboundContent, MAX_INBOUND_FILE_BYTES } from "../../transport/content.js";
import {
  type ArrivalRoute,
  type NormalizeArrivalDeps,
  normalizeArrival,
} from "./normalize-arrival.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

type FakeRecord = { state: "decoding"; attempts: number } | FinishedOriginal;

/** `attachment_originals` in memory, keyed by original path, with the store's transition rules. */
function originalsStore(initial: Record<string, FakeRecord> = {}) {
  const records = new Map<string, FakeRecord>(Object.entries(initial));
  const store: NormalizeArrivalDeps["transportStore"] = {
    claimAttachmentDecode: vi.fn(async (_tx, originalPath: string) => {
      const record = records.get(originalPath);
      if (record === undefined) {
        records.set(originalPath, { state: "decoding", attempts: 1 });
        return { kind: "claimed" as const, attempt: 1 };
      }
      if (record.state !== "decoding") return { kind: "existing" as const, original: record };
      const attempt = record.attempts + 1;
      records.set(originalPath, { state: "decoding", attempts: attempt });
      return { kind: "claimed" as const, attempt };
    }),
    finishAttachmentDecode: vi.fn(
      async (_tx, originalPath: string, result: NormalizedImageResult) => {
        const record = records.get(originalPath);
        if (record === undefined) return { kind: "absent" as const };
        if (record.state !== "decoding") return { kind: "stale" as const, original: record };
        records.set(originalPath, { state: "ready", result });
        return { kind: "finished" as const };
      },
    ),
    abandonAttachmentDecode: vi.fn(async (_tx, originalPath: string) => {
      if (records.get(originalPath)?.state !== "decoding") return { kind: "stale" as const };
      records.delete(originalPath);
      return { kind: "abandoned" as const };
    }),
  };
  return { store, records };
}

const JPEG = Buffer.from("jpeg-bytes");

function deps(overrides: Partial<NormalizeArrivalDeps> = {}) {
  const { store, records } = originalsStore();
  const images: NormalizeArrivalDeps["images"] = {
    screen: vi.fn(() => null),
    normalize: vi.fn(async () =>
      ok({
        data: Buffer.alloc(300_000),
        mediaType: "image/jpeg" as const,
        width: 2000,
        height: 1500,
      }),
    ),
  };
  const attachments = mockAttachmentStore({ read: vi.fn(async () => ok(JPEG)) });
  return {
    records,
    deps: {
      runInTx: fakeRunInTx,
      transportStore: store,
      attachments,
      images,
      ...overrides,
    } satisfies NormalizeArrivalDeps,
  };
}

const route: ArrivalRoute = {
  budget: { bytes: 24_000_000, images: 100 },
  textDocumentBytes: undefined,
  textDocumentTokens: 50_000,
  countTokens: async (text) => Math.ceil(text.length / 4),
};

function photo(path: string, name?: string): InboundContent {
  return [
    { type: "text", text: "look" },
    { type: "image", path, mediaType: "image/jpeg", ...(name !== undefined && { name }) },
  ];
}

describe("normalizeArrival", () => {
  it("keeps a batch without attachments as the joined text it was, resolving no route", async () => {
    const resolveRoute = vi.fn(async () => route);
    const { deps: d } = deps();
    const content = await normalizeArrival(d, resolveRoute, [
      { content: "hi" },
      { content: [{ type: "text", text: "there" }] },
    ]);
    expect(content).toBe("hi\nthere");
    expect(resolveRoute).not.toHaveBeenCalled();
  });

  it("stores an image as its label and ref under a key derived from the original's", async () => {
    const { deps: d, records } = deps();
    const content = await normalizeArrival(d, async () => route, [
      { content: photo("inbound/abc.heic", "cat.jpg") },
    ]);
    expect(content).toEqual([
      { type: "text", text: "look" },
      { type: "text", text: "Image 1: normalized/abc.jpg (cat.jpg)", harness: "image_label" },
      {
        type: "image_ref",
        path: "normalized/abc.jpg",
        mediaType: "image/jpeg",
        width: 2000,
        height: 1500,
        bytes: 300_000,
        name: "cat.jpg",
        original: { path: "inbound/abc.heic", mediaType: "image/jpeg" },
      },
    ]);
    expect(d.attachments.put).toHaveBeenCalledWith(
      "normalized/abc",
      expect.any(Buffer),
      "image/jpeg",
    );
    expect(records.get("inbound/abc.heic")).toMatchObject({ state: "ready" });
  });

  it("reuses a ready record without decoding or uploading", async () => {
    const { store } = originalsStore({
      "inbound/abc.jpg": {
        state: "ready",
        result: {
          kind: "image",
          path: "normalized/abc.jpg",
          mediaType: "image/png",
          width: 10,
          height: 20,
          bytes: 99,
        },
      },
    });
    const { deps: d } = deps({ transportStore: store });
    const content = await normalizeArrival(d, async () => route, [
      { content: photo("inbound/abc.jpg") },
    ]);
    expect(d.images.normalize).not.toHaveBeenCalled();
    expect(d.attachments.put).not.toHaveBeenCalled();
    expect(content).toContainEqual(
      expect.objectContaining({ type: "image_ref", mediaType: "image/png", bytes: 99 }),
    );
  });

  it("decodes again after one death, and records the crash placeholder after two", async () => {
    const path = "inbound/abc.jpg";
    const once = originalsStore({ [path]: { state: "decoding", attempts: 1 } });
    const retried = deps({ transportStore: once.store });
    await normalizeArrival(retried.deps, async () => route, [{ content: photo(path) }]);
    expect(retried.deps.images.normalize).toHaveBeenCalledOnce();

    const twice = originalsStore({ [path]: { state: "decoding", attempts: 2 } });
    const crashed = deps({ transportStore: twice.store });
    const content = await normalizeArrival(crashed.deps, async () => route, [
      { content: photo(path) },
    ]);
    expect(crashed.deps.images.normalize).not.toHaveBeenCalled();
    expect(twice.records.get(path)).toEqual({
      state: "ready",
      result: { kind: "placeholder", reason: "decode_crashed" },
    });
    expect(content).toContainEqual({
      type: "text",
      text: "[Image: photo. The image couldn't be read; send it as a photo.]",
      harness: "attachment_placeholder",
    });
  });

  it("records sharp's refusal as ready with its placeholder", async () => {
    const { deps: d, records } = deps();
    d.images.normalize = vi.fn(async () => err("too_large" as const));
    const content = await normalizeArrival(d, async () => route, [
      { content: photo("inbound/big.png", "big.png") },
    ]);
    expect(records.get("inbound/big.png")).toEqual({
      state: "ready",
      result: { kind: "placeholder", reason: "too_large" },
    });
    expect(content).toContainEqual(
      expect.objectContaining({ text: "[Image: big.png. Too large to attach.]" }),
    );
  });

  it("leaves no record when the decode or upload throws", async () => {
    const { deps: d, records } = deps();
    d.attachments.put = vi.fn(async () => {
      throw new Error("bucket down");
    });
    await expect(
      normalizeArrival(d, async () => route, [{ content: photo("inbound/abc.jpg") }]),
    ).rejects.toThrow("bucket down");
    expect(records.has("inbound/abc.jpg")).toBe(false);
  });

  it("adopts the result another attempt recorded first", async () => {
    const { store, records } = originalsStore();
    const other: NormalizedImageResult = { kind: "placeholder", reason: "undecodable" };
    const { deps: d } = deps({ transportStore: store });
    d.images.normalize = vi.fn(async () => {
      records.set("inbound/abc.jpg", { state: "ready", result: other });
      return ok({ data: Buffer.alloc(10), mediaType: "image/jpeg" as const, width: 1, height: 1 });
    });
    const content = await normalizeArrival(d, async () => route, [
      { content: photo("inbound/abc.jpg") },
    ]);
    expect(content).toContainEqual(expect.objectContaining({ harness: "attachment_placeholder" }));
  });

  it("keeps its own result unrecorded when another attempt abandoned the record", async () => {
    const { store, records } = originalsStore();
    const { deps: d } = deps({ transportStore: store });
    d.images.normalize = vi.fn(async () => {
      records.delete("inbound/abc.jpg");
      return ok({ data: Buffer.alloc(10), mediaType: "image/jpeg" as const, width: 1, height: 1 });
    });
    const content = await normalizeArrival(d, async () => route, [
      { content: photo("inbound/abc.jpg") },
    ]);
    expect(content).toContainEqual(expect.objectContaining({ type: "image_ref", bytes: 10 }));
    expect(records.has("inbound/abc.jpg")).toBe(false);
  });

  it("stores a rejected original as the rejection placeholder without decoding", async () => {
    const { store } = originalsStore({ "inbound/abc.jpg": { state: "rejected" } });
    const { deps: d } = deps({ transportStore: store });
    const content = await normalizeArrival(d, async () => route, [
      { content: photo("inbound/abc.jpg", "a.jpg") },
    ]);
    expect(d.images.normalize).not.toHaveBeenCalled();
    expect(content).toContainEqual({
      type: "text",
      text: "[Image: a.jpg. The model provider refused this file; ask for it another way.]",
      harness: "attachment_placeholder",
    });
  });

  it("stores a missing original as a placeholder", async () => {
    const { deps: d } = deps();
    d.attachments.read = vi.fn(async () => err({ kind: "missing" as const }));
    const content = await normalizeArrival(d, async () => route, [
      { content: photo("inbound/gone.jpg") },
    ]);
    expect(content).toContainEqual({
      type: "text",
      text: "[Image: photo. The file couldn't be stored; send it again.]",
      harness: "attachment_placeholder",
    });
  });

  it("refuses an original over 20 MB before any decode", async () => {
    const { deps: d } = deps();
    d.attachments.read = vi.fn(async () => ok(Buffer.alloc(MAX_INBOUND_FILE_BYTES + 1)));
    const content = await normalizeArrival(d, async () => route, [
      { content: photo("inbound/huge.jpg") },
    ]);
    expect(content).toContainEqual(
      expect.objectContaining({ text: "[Image: photo. Too large to attach.]" }),
    );
    expect(d.transportStore.claimAttachmentDecode).not.toHaveBeenCalled();
  });

  it("stores a timed-out decode as a placeholder and leaves no record to reuse", async () => {
    const { deps: d, records } = deps();
    d.images.normalize = vi.fn(async () => err("timeout" as const));
    const content = await normalizeArrival(d, async () => route, [
      { content: photo("inbound/slow.jpg") },
    ]);
    expect(records.has("inbound/slow.jpg")).toBe(false);
    expect(content).toContainEqual({
      type: "text",
      text: "[Image: photo. The image took too long to process; send it again.]",
      harness: "attachment_placeholder",
    });
  });

  it("joins the batch's text by newlines and drops blank text", async () => {
    const { deps: d } = deps();
    const content = await normalizeArrival(d, async () => route, [
      { content: "hello" },
      { content: [{ type: "text", text: "  " }] },
      { content: photo("inbound/a.jpg") },
    ]);
    expect(content).toEqual([
      { type: "text", text: "hello\nlook" },
      expect.objectContaining({ harness: "image_label" }),
      expect.objectContaining({ type: "image_ref" }),
    ]);
  });

  it("caps the turn's images to the route, numbering only those stored", async () => {
    const { deps: d } = deps();
    const content = await normalizeArrival(
      d,
      async () => ({ ...route, budget: { bytes: 24_000_000, images: 1 } }),
      [{ content: photo("inbound/a.jpg") }, { content: photo("inbound/b.jpg", "b.jpg") }],
    );
    expect(content).toContainEqual(
      expect.objectContaining({ text: "Image 1: normalized/a.jpg", harness: "image_label" }),
    );
    expect(content).toContainEqual({
      type: "text",
      text: "[Image: b.jpg. Not attached; send fewer files at a time.]",
      harness: "attachment_placeholder",
    });
  });

  it("caps the turn's attachments by their base64 bytes", async () => {
    const { deps: d } = deps();
    // 300,000 bytes is 400,000 of base64: one fits 500,000, two don't.
    const content = await normalizeArrival(
      d,
      async () => ({ ...route, budget: { bytes: 500_000, images: 100 } }),
      [{ content: photo("inbound/a.jpg") }, { content: photo("inbound/b.jpg") }],
    );
    expect(content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining("Not attached") }),
    );
  });

  it("uploads an inline original under its digest before normalizing it", async () => {
    const { deps: d } = deps();
    await normalizeArrival(d, async () => route, [
      {
        content: [
          {
            type: "image",
            source: "base64",
            data: JPEG.toString("base64"),
            mediaType: "image/jpeg",
          },
        ],
      },
    ]);
    expect(d.attachments.put).toHaveBeenCalledWith(
      expect.stringMatching(/^inbound\/[0-9a-f]{64}$/),
      JPEG,
      "image/jpeg",
    );
  });

  it.each([
    [
      "a URL attachment",
      {
        type: "image" as const,
        source: "url" as const,
        data: "https://x/y.png",
        mediaType: "image/png",
      },
      "[Image: photo. Linked files aren't fetched.]",
    ],
    [
      "a size-only file",
      { type: "document" as const, mediaType: "video/mp4", name: "clip.mp4", bytes: 50_000_000 },
      "[Document: clip.mp4. Too large to attach.]",
    ],
    [
      "a binary document",
      {
        type: "document" as const,
        path: "inbound/x.docx",
        mediaType: "application/msword",
        name: "x.docx",
      },
      "[Document: x.docx. This file type can't be read; send a PDF or text.]",
    ],
  ])("stores %s as a placeholder", async (_, block, text) => {
    const { deps: d } = deps();
    expect(await normalizeArrival(d, async () => route, [{ content: [block] }])).toEqual([
      { type: "text", text, harness: "attachment_placeholder" },
    ]);
  });

  it("takes a HEIC document through the image steps to the HEIC placeholder", async () => {
    const { deps: d } = deps();
    d.images.screen = vi.fn(() => "heic" as const);
    const content = await normalizeArrival(d, async () => route, [
      {
        content: [
          { type: "document", path: "inbound/a.heic", mediaType: "image/heic", name: "a.heic" },
        ],
      },
    ]);
    expect(content).toEqual([
      {
        type: "text",
        text: "[Image: a.heic. HEIC isn't supported; send it as a photo.]",
        harness: "attachment_placeholder",
      },
    ]);
    expect(d.transportStore.claimAttachmentDecode).not.toHaveBeenCalled();
  });

  it("stores a PDF as sent, and a locked or headerless one as a placeholder", async () => {
    const pdf = (bytes: string) => {
      const { deps: d } = deps();
      d.attachments.read = vi.fn(async () => ok(Buffer.from(bytes, "latin1")));
      return normalizeArrival(d, async () => route, [
        {
          content: [
            {
              type: "document",
              path: "inbound/r.pdf",
              mediaType: "application/pdf",
              name: "r.pdf",
            },
          ],
        },
      ]);
    };
    expect(await pdf("%PDF-1.7 body")).toEqual([
      {
        type: "document_ref",
        path: "inbound/r.pdf",
        mediaType: "application/pdf",
        name: "r.pdf",
        bytes: 13,
      },
    ]);
    const locked = "[Document: r.pdf. The PDF couldn't be read; send an unlocked PDF.]";
    expect(await pdf("%PDF-1.7 /Encrypt 5 0 R")).toEqual([
      { type: "text", text: locked, harness: "attachment_placeholder" },
    ]);
    expect(await pdf("not a pdf")).toEqual([
      { type: "text", text: locked, harness: "attachment_placeholder" },
    ]);
  });

  describe("text documents", () => {
    function text(body: string, routeOverrides: Partial<ArrivalRoute>) {
      const { deps: d } = deps();
      d.attachments.read = vi.fn(async () => ok(Buffer.from(body, "utf8")));
      const content = normalizeArrival(d, async () => ({ ...route, ...routeOverrides }), [
        {
          content: [
            { type: "document", path: "inbound/n.txt", mediaType: "text/plain", name: "n.txt" },
          ],
        },
      ]);
      return { d, content };
    }

    it("stores a blank text as a placeholder without counting it", async () => {
      const countTokens = vi.fn(async () => 0);
      const { content } = text(" \n", { countTokens });
      expect(await content).toEqual([
        {
          type: "text",
          text: "[Document: n.txt. The file is empty.]",
          harness: "attachment_placeholder",
        },
      ]);
      expect(countTokens).not.toHaveBeenCalled();
    });

    it("never cuts between the halves of a surrogate pair", async () => {
      // Every character is a pair, so a proportional cut lands mid-pair half the time.
      const { d, content } = text("😀".repeat(1_001), {
        textDocumentTokens: 333,
        countTokens: async (t) => t.length,
      });
      await content;
      const sent = vi.mocked(d.attachments.put).mock.calls[0]?.[1]?.toString("utf8") ?? "";
      expect(sent).not.toContain("\uFFFD");
    });

    it("stores a text that fits as the original", async () => {
      const { d, content } = text("hello", {});
      expect(await content).toEqual([
        {
          type: "document_ref",
          path: "inbound/n.txt",
          mediaType: "text/plain",
          name: "n.txt",
          bytes: 5,
        },
      ]);
      expect(d.attachments.put).not.toHaveBeenCalled();
    });

    it("cuts a text to the adapter's byte cap, storing the cut beside the original", async () => {
      const { d, content } = text("é".repeat(1_000), { textDocumentBytes: 600 });
      const [ref] = await content;
      expect(ref).toMatchObject({
        type: "document_ref",
        path: expect.stringMatching(/^normalized\/n\.\d+\.plain$/),
        original: { path: "inbound/n.txt", mediaType: "text/plain" },
      });
      const sent = vi.mocked(d.attachments.put).mock.calls[0]?.[1];
      expect(sent?.length).toBeLessThanOrEqual(600);
      expect(sent?.toString("utf8")).toContain("[Truncated: the first");
    });

    it("cuts a text to a quarter of the input budget in tokens", async () => {
      const { d, content } = text("word ".repeat(10_000), { textDocumentTokens: 1_000 });
      await content;
      const sent = vi.mocked(d.attachments.put).mock.calls[0]?.[1]?.toString("utf8") ?? "";
      expect(Math.ceil(sent.length / 4)).toBeLessThanOrEqual(1_000);
    });
  });
});
