import { describe, expect, it } from "vitest";
import type { Message, ToolDefinition } from "../../llm/types.js";
import { mockAttachmentStore } from "../../test/factories.js";
import { createAttachmentReader } from "../attachments/attachment-reader.js";
import { renderStoredMessages } from "../attachments/render-stored-content.js";
import { validateHistory } from "../history-invariants.js";
import type { StoredMessage } from "../stored-content.js";
import { type EpochSnapshot, stripThinkingBefore } from "../system-prompt-snapshot.js";
import {
  baseDigest,
  PrefixViolationError,
  type PrefixViolationPolicy,
  TranscriptHasher,
  type TranscriptHead,
} from "../transcript-head.js";
import { type CheckTurnHeadArgs, checkTurnHead } from "./check-turn-head.js";

const SYSTEM = "EPOCH PROMPT";
const TOOLS: ToolDefinition[] = [
  { name: "echo", description: "echo", parameters: { type: "object", properties: {} } },
];
const BASE = baseDigest(SYSTEM, TOOLS);
const thinking = { type: "thinking", thinking: "hmm", signature: "sig" } as const;

/** A stored row with its id. */
interface Row extends StoredMessage {
  id: string;
}

function reader() {
  return createAttachmentReader(mockAttachmentStore(), 24_000_000);
}

/** The epoch opened by `openedBy`, sent under `SYSTEM`. */
function epoch(openedBy: string, attachmentCutoff: string | null): EpochSnapshot {
  return {
    openedBy,
    historyStart: "m1",
    rendered: SYSTEM,
    configDigest: "digest",
    attachmentCutoff,
  };
}

/**
 * The heads the turns that wrote `rows` stored: each listed assistant row's
 * head over the rows up to it, rendered under `snapshot`'s cutoff with the
 * thinking before its opening row stripped and the history sanitized, as the
 * loop sent them. `overrides` replaces fields of a row's head.
 */
async function headsFor(
  rows: ReadonlyArray<Row>,
  snapshot: EpochSnapshot,
  headed: ReadonlyArray<string>,
  overrides: Readonly<Record<string, Partial<TranscriptHead>>>,
): Promise<(TranscriptHead | null)[]> {
  const sent = await sentAs(rows, snapshot);
  const hasher = new TranscriptHasher();
  return rows.map((row, i) =>
    headed.includes(row.id)
      ? {
          ...hasher.head(BASE, sent.slice(0, i + 1)),
          base: BASE,
          historyStart: "m1",
          status: "intact",
          ...overrides[row.id],
        }
      : null,
  );
}

async function sentAs(rows: ReadonlyArray<Row>, snapshot: EpochSnapshot): Promise<Message[]> {
  const ids = rows.map((row) => row.id);
  const rendered = await renderStoredMessages(
    rows,
    ids,
    reader(),
    snapshot.attachmentCutoff ?? null,
  );
  return validateHistory(stripThinkingBefore(rendered, ids.indexOf(snapshot.openedBy))).messages;
}

/**
 * The check's arguments over `rows`, whose last row is the turn's own, with
 * the view rendering them under the epoch's cutoff, which the turn kept.
 */
async function args(
  rows: ReadonlyArray<Row>,
  heads: (TranscriptHead | null)[] | undefined,
  snapshot: EpochSnapshot | null,
  policy: PrefixViolationPolicy,
): Promise<CheckTurnHeadArgs> {
  const turnRow = rows.at(-1);
  if (turnRow === undefined) throw new Error("a history needs the turn's row");
  const turn = { id: turnRow.id, createdAt: "2026-11-08T00:00:00.000Z" };
  const ids = rows.map((row) => row.id);
  const cutoff = snapshot?.attachmentCutoff ?? null;
  return {
    transcript: {
      history: {
        messages: rows.map(({ role, content }) => ({ role, content })),
        messageIds: rows.map((row) => row.id),
        turnContexts: rows.map(() => null),
        ...(heads !== undefined && { heads }),
        turn,
      },
      turn,
    },
    view: {
      messages: await renderStoredMessages(rows, ids, reader(), cutoff),
      turnIndex: rows.length - 1,
      cutoff: { kind: "kept", cutoff },
    },
    snapshot,
    toolDefs: TOOLS,
    policy,
  };
}

/** Two turns of the epoch `m1` opened, then this turn's row. */
const TWO_TURNS: Row[] = [
  { id: "m1", role: "user", content: "first" },
  { id: "m2", role: "assistant", content: [thinking, { type: "text", text: "one" }] },
  { id: "m3", role: "user", content: "second" },
  { id: "m4", role: "assistant", content: [thinking, { type: "text", text: "two" }] },
  { id: "m5", role: "user", content: "third" },
];

async function verdict(
  rows: ReadonlyArray<Row>,
  heads: (TranscriptHead | null)[] | undefined,
  snapshot: EpochSnapshot | null,
) {
  return checkTurnHead(await args(rows, heads, snapshot, "reopen"));
}

describe("checkTurnHead", () => {
  const EPOCH = epoch("m1", null);

  describe("skips", () => {
    it("a conversation with no epoch yet", async () => {
      const heads = await headsFor(TWO_TURNS, EPOCH, ["m2", "m4"], {});
      expect(await verdict(TWO_TURNS, heads, null)).toEqual({ kind: "skipped" });
    });

    it("a transcript memoized before heads", async () => {
      expect(await verdict(TWO_TURNS, undefined, EPOCH)).toEqual({ kind: "skipped" });
    });

    it("a history with no headed row", async () => {
      expect(
        await verdict(
          TWO_TURNS,
          TWO_TURNS.map(() => null),
          EPOCH,
        ),
      ).toEqual({
        kind: "skipped",
      });
    });

    it("heads written before the epoch's opening row, as when the opening turn failed", async () => {
      // m5's epoch opened at m3 and wrote no reply; m2's head predates it,
      // whatever m3's opening rewrote.
      const opened = epoch("m3", null);
      const heads = await headsFor(TWO_TURNS, EPOCH, ["m2"], { m2: { digest: "0".repeat(64) } });
      expect(await verdict(TWO_TURNS, heads, opened)).toEqual({ kind: "skipped" });
    });

    it("an epoch whose opening row isn't in the history, which opened after the load", async () => {
      const heads = await headsFor(TWO_TURNS, EPOCH, ["m2", "m4"], {
        m4: { digest: "0".repeat(64) },
      });
      expect(await verdict(TWO_TURNS, heads, epoch("m-later", null))).toEqual({
        kind: "skipped",
      });
    });
  });

  describe("matches", () => {
    it("a history that still has its latest head", async () => {
      const heads = await headsFor(TWO_TURNS, EPOCH, ["m2", "m4"], {});
      expect(await verdict(TWO_TURNS, heads, EPOCH)).toEqual({ kind: "matched" });
    });

    it("over the view's own render when the turn kept the epoch's cutoff", async () => {
      const heads = await headsFor(TWO_TURNS, EPOCH, ["m2", "m4"], {});
      const base = await args(TWO_TURNS, heads, EPOCH, "reopen");
      const kept = (messages: Message[]): CheckTurnHeadArgs => ({
        ...base,
        view: { messages, turnIndex: 4, cutoff: { kind: "kept", cutoff: null } },
      });
      const rendered = await sentAs(TWO_TURNS, EPOCH);
      const edited = rendered.with(1, { role: "assistant", content: "edited" });

      expect(checkTurnHead(kept(rendered))).toEqual({ kind: "matched" });
      expect(checkTurnHead(kept(edited))).toMatchObject({ kind: "violated" });
    });

    it("nothing when the turn advanced its attachment cutoff, but still explains a head", async () => {
      const heads = await headsFor(TWO_TURNS, EPOCH, ["m2", "m4"], {});
      const base = await args(TWO_TURNS, heads, EPOCH, "throw");
      const advanced = (h: (TranscriptHead | null)[]): CheckTurnHeadArgs => ({
        ...base,
        transcript: { ...base.transcript, history: { ...base.transcript.history, heads: h } },
        view: { messages: [], turnIndex: 4, cutoff: { kind: "advanced", cutoff: "m2" } },
      });
      const compacted = await headsFor(TWO_TURNS, EPOCH, ["m2", "m4"], {
        m4: { status: "compacted" },
      });

      expect(checkTurnHead(advanced(heads))).toEqual({ kind: "skipped" });
      expect(checkTurnHead(advanced(compacted))).toEqual({
        kind: "explained",
        reason: "compaction",
      });
    });

    it("rendered with the thinking before the epoch's opening row stripped", async () => {
      // The epoch opened at m3; its turns sent m2 without its thinking block.
      const opened = epoch("m3", null);
      const heads = await headsFor(TWO_TURNS, opened, ["m4"], {});
      expect(await verdict(TWO_TURNS, heads, opened)).toEqual({ kind: "matched" });

      // The same head over m2 as stored doesn't hold.
      const unstripped = await headsFor(TWO_TURNS, EPOCH, ["m4"], {});
      expect(await verdict(TWO_TURNS, unstripped, opened)).toMatchObject({ kind: "violated" });
    });

    it("a view showing a cut image as the placeholder the epoch's turns sent", async () => {
      const photo: Row = {
        id: "m1",
        role: "user",
        content: [
          {
            type: "image_ref",
            path: "normalized/1.jpg",
            mediaType: "image/jpeg",
            width: 10,
            height: 10,
            bytes: 3,
            original: { path: "inbound/1.jpg", mediaType: "image/jpeg" },
          },
        ],
      };
      const rows = [photo, ...TWO_TURNS.slice(1)];
      const cut = epoch("m1", "m1");
      const heads = await headsFor(rows, cut, ["m2", "m4"], {});
      expect(await verdict(rows, heads, cut)).toEqual({ kind: "matched" });

      // A view showing the image itself, which those turns didn't send, doesn't.
      expect(await verdict(rows, heads, EPOCH)).toMatchObject({ kind: "violated" });
    });

    it("sanitized as the turn's transcript sanitizes its history", async () => {
      // m2's call has no result; the loop sent m3 led by a synthesized one.
      const rows: Row[] = [
        { id: "m1", role: "user", content: "first" },
        {
          id: "m2",
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }],
        },
        { id: "m3", role: "user", content: "second" },
        { id: "m4", role: "assistant", content: [{ type: "text", text: "two" }] },
        { id: "m5", role: "user", content: "third" },
      ];
      const sent = await sentAs(rows, EPOCH);
      expect(sent[2]?.content).toEqual([
        expect.objectContaining({ type: "tool_result", toolUseId: "t1", isError: true }),
        { type: "text", text: "second" },
      ]);
      const heads = await headsFor(rows, EPOCH, ["m4"], {});
      expect(await verdict(rows, heads, EPOCH)).toEqual({ kind: "matched" });

      // The same rows unsanitized aren't what the loop sent.
      const raw = await renderStoredMessages(
        rows,
        rows.map((row) => row.id),
        reader(),
        null,
      );
      const rawHead: TranscriptHead = {
        ...new TranscriptHasher().head(BASE, raw.slice(0, 4)),
        base: BASE,
        historyStart: "m1",
        status: "intact",
      };
      expect(await verdict(rows, [null, null, null, rawHead, null], EPOCH)).toMatchObject({
        kind: "violated",
      });
    });
  });

  describe("explains", () => {
    it.each<{ name: string; head: Partial<TranscriptHead>; reason: string }>([
      {
        name: "a head under another base",
        head: { base: "c".repeat(64) },
        reason: "configuration",
      },
      {
        name: "a head from another history start",
        head: { historyStart: "m0" },
        reason: "summary",
      },
      { name: "a compacted head", head: { status: "compacted" }, reason: "compaction" },
      { name: "a diverged head", head: { status: "diverged" }, reason: "prefix_violation" },
      {
        name: "another base before another start and a status",
        head: { base: "c".repeat(64), historyStart: "m0", status: "compacted" },
        reason: "configuration",
      },
      {
        name: "another start before a status",
        head: { historyStart: "m0", status: "diverged" },
        reason: "summary",
      },
      {
        name: "a compacted head whose digest no longer holds",
        head: { status: "compacted", digest: "0".repeat(64) },
        reason: "compaction",
      },
    ])("$name as $reason", async ({ head, reason }) => {
      const heads = await headsFor(TWO_TURNS, EPOCH, ["m2", "m4"], { m4: head });
      expect(await verdict(TWO_TURNS, heads, EPOCH)).toEqual({ kind: "explained", reason });
    });

    it("by the latest headed row only", async () => {
      // A stage turn's reply after m4, under its own prompt and tools.
      const rows: Row[] = [
        ...TWO_TURNS.slice(0, 4),
        { id: "m5", role: "user", content: "stage prompt" },
        { id: "m6", role: "assistant", content: [{ type: "text", text: "plan" }] },
        { id: "m7", role: "user", content: "third" },
      ];
      const heads = await headsFor(rows, EPOCH, ["m2", "m4", "m6"], {
        m6: { base: baseDigest("STAGE PROMPT", []) },
      });
      expect(await verdict(rows, heads, EPOCH)).toEqual({
        kind: "explained",
        reason: "configuration",
      });
    });
  });

  describe("violates", () => {
    /** `TWO_TURNS` with `id`'s content replaced, as an edit to the stored row would. */
    function edited(id: string, text: string): Row[] {
      return TWO_TURNS.map((row) =>
        row.id === id ? { ...row, content: [{ type: "text", text }] } : row,
      );
    }

    it("when a matching head's digest no longer holds, naming its row", async () => {
      const heads = await headsFor(TWO_TURNS, EPOCH, ["m2", "m4"], {});
      expect(await verdict(edited("m4", "edited"), heads, EPOCH)).toEqual({
        kind: "violated",
        firstDiverging: "m4",
      });
    });

    it("naming the first assistant row whose head no longer holds", async () => {
      const heads = await headsFor(TWO_TURNS, EPOCH, ["m2", "m4"], {});
      expect(await verdict(edited("m2", "edited"), heads, EPOCH)).toEqual({
        kind: "violated",
        firstDiverging: "m2",
      });
    });

    it("past an earlier head that still holds", async () => {
      // m2's head holds; the history after it changed.
      const heads = await headsFor(TWO_TURNS, EPOCH, ["m2", "m4"], {});
      expect(await verdict(edited("m3", "edited"), heads, EPOCH)).toEqual({
        kind: "violated",
        firstDiverging: "m4",
      });
    });

    it("when a head is longer than the history", async () => {
      const heads = await headsFor(TWO_TURNS, EPOCH, ["m2", "m4"], { m4: { length: 9 } });
      expect(await verdict(TWO_TURNS, heads, EPOCH)).toEqual({
        kind: "violated",
        firstDiverging: "m4",
      });
    });

    it("throws a PrefixViolationError under throw", async () => {
      const heads = await headsFor(TWO_TURNS, EPOCH, ["m2", "m4"], {});
      const check = await args(edited("m4", "edited"), heads, EPOCH, "throw");
      expect(() => checkTurnHead(check)).toThrow(PrefixViolationError);
      expect(() => checkTurnHead(check)).toThrow(/assistant row m4/);
    });

    it("doesn't throw under throw when the head matches", async () => {
      const heads = await headsFor(TWO_TURNS, EPOCH, ["m2", "m4"], {});
      expect(checkTurnHead(await args(TWO_TURNS, heads, EPOCH, "throw"))).toEqual({
        kind: "matched",
      });
    });
  });
});
