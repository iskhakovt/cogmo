import { describe, expect, it, vi } from "vitest";
import { logger } from "../../logger.js";
import { fakeRunInTx, mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { type FakeDurable, fakeDurable } from "../../test/fake-durable.js";
import type { StoredContent, StoredMessage } from "../stored-content.js";
import type { ProviderRefusal } from "../turn-step-runner.js";
import { markRejectedAttachments } from "./mark-rejected-attachments.js";

const PDF_ROW: StoredContent = [
  { type: "text", text: "read this" },
  {
    type: "document_ref",
    path: "inbound/r.pdf",
    mediaType: "application/pdf",
    name: "r.pdf",
    bytes: 3,
  },
];

const PHOTO_ROW: StoredContent = [
  { type: "text", text: "Image 1: normalized/a.jpg", harness: "image_label" },
  {
    type: "image_ref",
    path: "normalized/a.jpg",
    mediaType: "image/jpeg",
    width: 10,
    height: 10,
    bytes: 6,
    original: { path: "inbound/a.png", mediaType: "image/png" },
  },
];

type Row = StoredMessage & { id: string; cursor: string };

function deps(rows: ReadonlyArray<Row>, lastReply: string | null) {
  return {
    runInTx: fakeRunInTx,
    agentStore: mockAgentStore({
      getLastAssistantMessage: vi
        .fn()
        .mockResolvedValue(
          lastReply === null ? undefined : { id: lastReply, lastInboundMessageId: "inbound-0" },
        ),
      listUserRowsAfter: vi.fn().mockResolvedValue(rows),
    }),
    transportStore: mockTransportStore({
      rejectAttachmentOriginals: vi.fn().mockResolvedValue(2),
    }),
  };
}

const FIRST_REQUEST: ProviderRefusal = { status: 400, step: "llm-iter1", cursor: "inbound-3" };

function mark(d: ReturnType<typeof deps>, refusal: ProviderRefusal | null, step: FakeDurable) {
  return markRejectedAttachments(step, d, {
    conversationId: "conv-1",
    refusal,
    turnLogger: logger,
  });
}

describe("markRejectedAttachments", () => {
  it.each([
    [400, "bad_request"],
    [413, "too_large"],
  ] as const)(
    "marks the originals the refused turn sent on a %i, as %s",
    async (status, rejection) => {
      // The turn re-sent an earlier failed turn's row, and its own insert
      // re-ran: both of its rows name the PDF.
      const d = deps(
        [
          { id: "m3", role: "user", content: PDF_ROW, cursor: "inbound-2" },
          { id: "m4", role: "user", content: [...PDF_ROW, ...PHOTO_ROW], cursor: "inbound-3" },
          { id: "m5", role: "user", content: "and a plain row", cursor: "inbound-3" },
        ],
        "m2",
      );
      const step = fakeDurable();

      await mark(d, { ...FIRST_REQUEST, status }, step);

      expect(step.stepIds()).toEqual(["mark-rejected-attachments"]);
      expect(d.agentStore.listUserRowsAfter).toHaveBeenCalledWith(expect.anything(), {
        conversationId: "conv-1",
        afterMessageId: "m2",
      });
      expect(d.transportStore.rejectAttachmentOriginals).toHaveBeenCalledWith(
        expect.anything(),
        ["inbound/r.pdf", "inbound/r.pdf", "inbound/a.png"],
        rejection,
      );
    },
  );

  it("leaves what a later turn's row sent to that turn", async () => {
    // A turn admitted after the failure re-sent the PDF.
    const d = deps(
      [
        { id: "m3", role: "user", content: PDF_ROW, cursor: "inbound-2" },
        { id: "m4", role: "user", content: PHOTO_ROW, cursor: "inbound-3" },
        { id: "m5", role: "user", content: PDF_ROW, cursor: "inbound-4" },
      ],
      "m2",
    );

    await mark(d, FIRST_REQUEST, fakeDurable());

    expect(d.transportStore.rejectAttachmentOriginals).toHaveBeenCalledWith(
      expect.anything(),
      ["inbound/a.png"],
      "bad_request",
    );
  });

  it("reads from the start of a conversation with no reply yet", async () => {
    const d = deps([{ id: "m1", role: "user", content: PHOTO_ROW, cursor: "inbound-1" }], null);

    await mark(d, { ...FIRST_REQUEST, step: "count-tokens-1" }, fakeDurable());

    expect(d.agentStore.listUserRowsAfter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ afterMessageId: null }),
    );
    expect(d.transportStore.rejectAttachmentOriginals).toHaveBeenCalledWith(
      expect.anything(),
      ["inbound/a.png"],
      "bad_request",
    );
  });

  it.each<[string, ProviderRefusal | null]>([
    ["a 401", { ...FIRST_REQUEST, status: 401 }],
    ["a 429", { ...FIRST_REQUEST, status: 429 }],
    [
      "a later iteration, after the provider accepted the rows",
      { ...FIRST_REQUEST, step: "llm-iter2" },
    ],
    [
      "a later count, after the provider counted the rows",
      { ...FIRST_REQUEST, step: "count-tokens-2" },
    ],
    ["the degraded reply's fork", { ...FIRST_REQUEST, step: "degraded-reply" }],
    ["a failure that wasn't a refusal", null],
  ])("marks nothing on %s", async (_label, refusal) => {
    const d = deps([{ id: "m3", role: "user", content: PDF_ROW, cursor: "inbound-3" }], "m2");
    const step = fakeDurable();

    await mark(d, refusal, step);

    expect(step.stepIds()).toEqual([]);
    expect(d.transportStore.rejectAttachmentOriginals).not.toHaveBeenCalled();
  });

  it("returns the memoized step without marking again", async () => {
    const d = deps([{ id: "m3", role: "user", content: PDF_ROW, cursor: "inbound-3" }], "m2");
    const step = fakeDurable({ memo: { "mark-rejected-attachments": 1 } });

    await mark(d, FIRST_REQUEST, step);

    expect(step.stepIds()).toEqual(["mark-rejected-attachments"]);
    expect(d.transportStore.rejectAttachmentOriginals).not.toHaveBeenCalled();
  });

  it("logs a step that fails for good instead of failing the handler", async () => {
    const d = deps([{ id: "m3", role: "user", content: PDF_ROW, cursor: "inbound-3" }], "m2");
    vi.mocked(d.transportStore.rejectAttachmentOriginals).mockRejectedValue(new Error("db down"));
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    await expect(mark(d, FIRST_REQUEST, fakeDurable())).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: "db down" }) },
      "could not mark the refused turn's attachments",
    );
    error.mockRestore();
  });
});
