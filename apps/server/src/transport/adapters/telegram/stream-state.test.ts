import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { StreamOpts } from "../../types.js";
import { renderTelegramHtml } from "./render.js";
import {
  classifyWriteError,
  crashed,
  EDIT_INTERVAL_MS,
  type Effect,
  findTelegramSplitBoundary,
  MAX_FAILURES_IN_A_ROW,
  MAX_WAIT_MS,
  rebalanceCodeFence,
  type StreamInput,
  type StreamState,
  transition,
  type Write,
} from "./stream-state.js";

vi.mock("./render.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render.js")>();
  return { ...actual, renderTelegramHtml: vi.fn(actual.renderTelegramHtml) };
});

const EDITS: StreamOpts = { chunkChars: 4000, allowEdits: true };
const APPEND_ONLY: StreamOpts = { chunkChars: 4000, allowEdits: false };
const T0 = 1_000_000;

/** Feed `inputs` in order: the final state, and every effect along the way. */
function drive(
  opts: StreamOpts,
  inputs: ReadonlyArray<StreamInput>,
  from: StreamState = { kind: "idle" },
): { state: StreamState; effects: Effect[] } {
  return inputs.reduce<{ state: StreamState; effects: Effect[] }>(
    (acc, input) => {
      const next = transition(acc.state, input, opts);
      return { state: next.state, effects: [...acc.effects, ...next.effects] };
    },
    { state: from, effects: [] },
  );
}

function writes(effects: ReadonlyArray<Effect>): Write[] {
  return effects.flatMap((effect) => (effect.type === "write" ? [effect.write] : []));
}

function text(t: string, now = T0): StreamInput {
  return { type: "push", event: { type: "text_delta", text: t }, now };
}

function landed(now: number, messageId?: number): StreamInput {
  return { type: "api_ok", messageId, now };
}

function rateLimited(seconds: number, now: number): StreamInput {
  return {
    type: "api_failed",
    failure: {
      kind: "rate_limited",
      retryAfterMs: seconds * 1000,
      reason: `retry after ${seconds}`,
    },
    now,
  };
}

function elapsed(now: number): StreamInput {
  return { type: "throttle_elapsed", now };
}

/** The message a write edits is gone, or can no longer be edited. */
function editGone(now: number): StreamInput {
  return {
    type: "api_failed",
    failure: { kind: "edit_target_gone", reason: "Bad Request: message to edit not found" },
    now,
  };
}

/** A 5xx or a network error: grammY's auto-retry treats both as transient. */
function transient(now: number): StreamInput {
  return {
    type: "api_failed",
    failure: { kind: "transient", reason: "Call to 'editMessageText' failed! (502: Bad Gateway)" },
    now,
  };
}

const finish: StreamInput = { type: "finish", now: T0 };

describe("telegram stream state", () => {
  describe("previews", () => {
    it("sends the first push as a new message and edits it once the interval passes", () => {
      const { state, effects } = drive(EDITS, [
        text("Hello"),
        landed(T0, 100),
        text(" world", T0 + EDIT_INTERVAL_MS - 1),
        text("!", T0 + EDIT_INTERVAL_MS),
      ]);

      expect(writes(effects)).toEqual([
        { role: "preview", messageId: undefined, text: "Hello", html: false },
        { role: "preview", messageId: 100, text: "Hello world!", html: false },
      ]);
      expect(state.kind).toBe("streaming");
    });

    it("starts no write while one is in flight", () => {
      const { effects } = drive(EDITS, [text("Hello"), text(" world", T0 + 10_000)]);

      expect(writes(effects)).toHaveLength(1);
    });

    it("takes an edit Telegram calls unmodified as landed", () => {
      const { state } = drive(EDITS, [
        text("Hello"),
        { type: "api_failed", failure: { kind: "not_modified" }, now: T0 },
      ]);

      expect(state).toMatchObject({ kind: "streaming", shown: "Hello", inFlight: null });
    });

    it("writes nothing in append-only mode until a chunk is due, and starts typing once", () => {
      const { effects } = drive(APPEND_ONLY, [
        text("Hello"),
        text(" world", T0 + 10_000),
        {
          type: "push",
          event: { type: "tool_start", id: "t1", name: "search", input: {} },
          now: T0 + 20_000,
        },
      ]);

      expect(writes(effects)).toEqual([]);
      expect(effects.filter((e) => e.type === "start_typing")).toHaveLength(1);
    });
  });

  describe("rate limits", () => {
    it("waits out retry_after on a preview, then previews the latest text", () => {
      const waited = drive(EDITS, [
        text("Hello"),
        landed(T0, 100),
        text(" world", T0 + 600),
        rateLimited(3, T0 + 600),
        text("!", T0 + 2000),
      ]);
      expect(waited.effects).toContainEqual({ type: "wait", ms: 3000 });
      expect(writes(waited.effects)).toHaveLength(2);

      const resumed = drive(EDITS, [elapsed(T0 + 3600)], waited.state);
      expect(writes(resumed.effects)).toEqual([
        { role: "preview", messageId: 100, text: "Hello world!", html: false },
      ]);
    });

    it("repeats a rate-limited chunk after the wait", () => {
      const waited = drive(EDITS, [text("done"), landed(T0, 100), finish, rateLimited(2, T0)]);
      const chunk = writes(waited.effects).at(-1);
      expect(chunk).toEqual({ role: "chunk", messageId: 100, text: "done", html: true });

      const resumed = drive(EDITS, [elapsed(T0 + 2000)], waited.state);
      expect(writes(resumed.effects)).toEqual([chunk]);
    });

    it("fails rather than wait longer than it will", () => {
      const { state, effects } = drive(EDITS, [
        text("Hello"),
        rateLimited(MAX_WAIT_MS / 1000 + 1, T0),
      ]);

      expect(state.kind).toBe("failed");
      expect(effects).not.toContainEqual(expect.objectContaining({ type: "wait" }));
      expect(effects).toContainEqual({ type: "stopped" });
      expect(effects).toContainEqual({
        type: "settled",
        outcome: err(expect.stringContaining("retry after")),
      });
    });

    it("fails once Telegram has rate-limited writes too many times in a row", () => {
      const limits = Array.from({ length: MAX_FAILURES_IN_A_ROW }, (_, i) => [
        rateLimited(1, T0 + i * 1000),
        elapsed(T0 + (i + 1) * 1000),
      ]).flat();
      const { state } = drive(EDITS, [text("Hello"), ...limits]);

      expect(state).toEqual({ kind: "failed", reason: expect.stringContaining("in a row") });
    });

    it("resets the count once a write lands", () => {
      const limits = Array.from({ length: MAX_FAILURES_IN_A_ROW - 1 }, (_, i) => [
        rateLimited(1, T0 + i * 1000),
        elapsed(T0 + (i + 1) * 1000),
      ]).flat();
      const { state } = drive(EDITS, [
        text("Hello"),
        ...limits,
        landed(T0 + 10_000, 100),
        text(" world", T0 + 20_000),
        rateLimited(1, T0 + 20_000),
      ]);

      expect(state).toMatchObject({ kind: "streaming", failedInARow: 1, waiting: true });
    });
  });

  describe("the close's wait budget", () => {
    /** Three chunks to write once the stream closes. */
    const threeChunks: StreamOpts = { chunkChars: 150, allowEdits: false };
    const reply = Array.from({ length: 3 }, () => "a".repeat(120)).join("\n\n");

    it("fails a closing stream whose next wait would pass 60s since the close", () => {
      const { state } = drive(threeChunks, [
        text(reply),
        { type: "finish", now: T0 },
        landed(T0),
        rateLimited(25, T0),
        elapsed(T0 + 25_000),
        landed(T0 + 25_000),
        rateLimited(25, T0 + 25_000),
        elapsed(T0 + 50_000),
        rateLimited(20, T0 + 50_000),
      ]);

      expect(state).toEqual({ kind: "failed", reason: expect.stringContaining("60000ms") });
    });

    it("lets a closing stream wait right up to the budget", () => {
      const { state } = drive(threeChunks, [
        text(reply),
        { type: "finish", now: T0 },
        landed(T0),
        rateLimited(30, T0),
        elapsed(T0 + 30_000),
        rateLimited(30, T0 + 30_000),
      ]);

      expect(state).toMatchObject({ kind: "finalizing", waiting: true });
    });

    it("does not count waits while streaming, which hold nothing up", () => {
      const waits = [0, 1, 2].flatMap((i) => {
        const at = T0 + i * 30_000;
        return [
          text(String(i), at),
          rateLimited(25, at),
          elapsed(at + 25_000),
          landed(at + 25_000),
        ];
      });
      const { state } = drive(EDITS, [text("Hello"), landed(T0, 100), ...waits]);

      expect(state.kind).toBe("streaming");
    });
  });

  describe("transient failures", () => {
    it("retries a chunk after a 5xx, backing off from 1s", () => {
      const waited = drive(EDITS, [text("done"), landed(T0, 100), finish, transient(T0)]);
      expect(waited.state.kind).toBe("finalizing");
      expect(waited.effects).toContainEqual({ type: "wait", ms: 1000 });
      const chunk = writes(waited.effects).at(-1);

      const resumed = drive(EDITS, [elapsed(T0 + 1000), landed(T0 + 1000)], waited.state);
      expect(writes(resumed.effects)).toEqual([chunk]);
      expect(resumed.state).toEqual({ kind: "done" });
    });

    it("doubles the backoff, and fails on the fifth failure in a row", () => {
      const failures = [0, 1, 2, 3].flatMap((i) => [transient(T0 + i), elapsed(T0 + i)]);
      const retried = drive(EDITS, [text("done"), landed(T0, 100), finish, ...failures]);
      expect(retried.effects.filter((e) => e.type === "wait")).toEqual([
        { type: "wait", ms: 1000 },
        { type: "wait", ms: 2000 },
        { type: "wait", ms: 4000 },
        { type: "wait", ms: 8000 },
      ]);
      expect(retried.state.kind).toBe("finalizing");

      const failed = drive(EDITS, [transient(T0 + 10)], retried.state);
      expect(failed.state).toEqual({ kind: "failed", reason: expect.stringContaining("502") });
      expect(failed.effects).not.toContainEqual(expect.objectContaining({ type: "wait" }));
    });

    it("counts rate limits and transient failures against one cap", () => {
      const failures = [0, 1, 2, 3].flatMap((i) => [
        i % 2 === 0 ? transient(T0 + i) : rateLimited(1, T0 + i),
        elapsed(T0 + i),
      ]);
      const { state } = drive(EDITS, [
        text("done"),
        landed(T0, 100),
        finish,
        ...failures,
        transient(T0 + 9),
      ]);

      expect(state.kind).toBe("failed");
    });

    it("waits out a transient failure on a preview, then previews the latest text", () => {
      const waited = drive(EDITS, [
        text("Hello"),
        landed(T0, 100),
        text(" world", T0 + 600),
        transient(T0 + 600),
        text("!", T0 + 1200),
      ]);
      expect(waited.effects).toContainEqual({ type: "wait", ms: 1000 });
      expect(writes(waited.effects)).toHaveLength(2);

      const resumed = drive(EDITS, [elapsed(T0 + 1600)], waited.state);
      expect(writes(resumed.effects)).toEqual([
        { role: "preview", messageId: 100, text: "Hello world!", html: false },
      ]);
    });
  });

  describe("edit target gone", () => {
    const rejected: StreamInput = {
      type: "api_failed",
      failure: { kind: "rejected", reason: "Forbidden: bot was blocked by the user" },
      now: T0,
    };

    it("sends a chunk whose message is gone as a new message", () => {
      const { state, effects } = drive(EDITS, [
        text("done"),
        landed(T0, 100),
        finish,
        editGone(T0),
        landed(T0, 101),
      ]);

      expect(writes(effects).slice(-2)).toEqual([
        { role: "chunk", messageId: 100, text: "done", html: true },
        { role: "chunk", messageId: undefined, text: "done", html: true },
      ]);
      expect(state).toEqual({ kind: "done" });
    });

    it("sends the abort's tail as a new message when its message is gone", () => {
      const { effects } = drive(EDITS, [
        text("partial"),
        landed(T0, 100),
        { type: "abort", error: "LLM failed", now: T0 },
        editGone(T0),
      ]);

      expect(writes(effects).at(-1)).toEqual({
        role: "tail",
        messageId: undefined,
        text: "partial\n\n⚠️ LLM failed",
        html: false,
      });
    });

    it("fails when the resend fails too", () => {
      const { state } = drive(EDITS, [
        text("done"),
        landed(T0, 100),
        finish,
        editGone(T0),
        rejected,
      ]);

      expect(state).toEqual({ kind: "failed", reason: "Forbidden: bot was blocked by the user" });
    });

    it("fails when a send reports its target gone, so the resend happens once", () => {
      const { state, effects } = drive(EDITS, [
        text("done"),
        landed(T0, 100),
        finish,
        editGone(T0),
        editGone(T0),
      ]);

      expect(writes(effects)).toHaveLength(3);
      expect(state).toEqual({ kind: "failed", reason: expect.stringContaining("not found") });
    });

    it("moves a preview whose message is gone to a new message, mid-stream", () => {
      const { state, effects } = drive(EDITS, [
        text("Hello"),
        landed(T0, 100),
        text(" world", T0 + 600),
        editGone(T0 + 600),
      ]);

      expect(state.kind).toBe("streaming");
      expect(writes(effects).at(-1)).toEqual({
        role: "preview",
        messageId: undefined,
        text: "Hello world",
        html: false,
      });
    });

    it("still writes the final text as a new message when a preview finds its message gone while closing", () => {
      const { state, effects } = drive(EDITS, [
        text("Hello"),
        landed(T0, 100),
        text(" world", T0 + 600),
        finish,
        editGone(T0 + 600),
      ]);

      expect(writes(effects).at(-1)).toEqual({
        role: "chunk",
        messageId: undefined,
        text: "Hello world",
        html: true,
      });
      expect(state).toMatchObject({ kind: "finalizing" });
    });
  });

  describe("failures", () => {
    const unparseable: StreamInput = {
      type: "api_failed",
      failure: { kind: "unparseable", reason: "can't parse entities" },
      now: T0,
    };

    it("falls back to the plain source when Telegram rejects a chunk's HTML", () => {
      const { effects } = drive(EDITS, [text("**done**"), landed(T0, 100), finish, unparseable]);

      expect(writes(effects).slice(-2)).toEqual([
        { role: "chunk", messageId: 100, text: "<b>done</b>", html: true },
        { role: "chunk", messageId: 100, text: "**done**", html: false },
      ]);
    });

    it("writes a chunk as plain text when rendering it throws", () => {
      vi.mocked(renderTelegramHtml).mockImplementationOnce(() => {
        throw new Error("marked blew up");
      });

      const { state, effects } = drive(EDITS, [text("**done**"), landed(T0, 100), finish]);

      expect(writes(effects).at(-1)).toEqual({
        role: "chunk",
        messageId: 100,
        text: "**done**",
        html: false,
      });
      expect(state).toMatchObject({ kind: "finalizing" });
      expect(effects).toContainEqual(
        expect.objectContaining({ type: "log", fields: { reason: "marked blew up" } }),
      );
    });

    it("fails when the plain fallback is rejected too", () => {
      const { state } = drive(EDITS, [
        text("**done**"),
        landed(T0, 100),
        finish,
        unparseable,
        unparseable,
      ]);

      expect(state).toEqual({ kind: "failed", reason: "can't parse entities" });
    });

    it("fails on a rejected write, and ignores every input after", () => {
      const rejected: StreamInput = {
        type: "api_failed",
        failure: { kind: "rejected", reason: "bot was blocked by the user" },
        now: T0,
      };
      const failed = drive(EDITS, [text("Hello"), rejected]);
      expect(failed.state).toEqual({ kind: "failed", reason: "bot was blocked by the user" });
      expect(failed.effects).toContainEqual({
        type: "settled",
        outcome: err("bot was blocked by the user"),
      });

      const after = drive(
        EDITS,
        [text("more", T0 + 10_000), finish, { type: "abort", error: "x", now: T0 }],
        failed.state,
      );
      expect(after).toEqual({ state: failed.state, effects: [] });
    });
  });

  describe("closing", () => {
    it("settles at once when finished before any push", () => {
      expect(drive(EDITS, [finish])).toEqual({
        state: { kind: "done" },
        effects: [{ type: "stopped" }, { type: "settled", outcome: ok(undefined) }],
      });
    });

    it("writes the buffer as a rendered chunk, then settles", () => {
      const { state, effects } = drive(EDITS, [text("Hello"), landed(T0, 100), finish, landed(T0)]);

      expect(writes(effects).at(-1)).toEqual({
        role: "chunk",
        messageId: 100,
        text: "Hello",
        html: true,
      });
      expect(state).toEqual({ kind: "done" });
      expect(effects.at(-1)).toEqual({ type: "settled", outcome: ok(undefined) });
    });

    it("waits for the write in flight before closing", () => {
      const { state, effects } = drive(EDITS, [text("Hello"), finish]);

      expect(writes(effects)).toHaveLength(1);
      expect(state).toMatchObject({ kind: "finalizing", closing: "finish" });
    });

    it("appends the error to the live message on abort, in plain text", () => {
      const { effects } = drive(EDITS, [
        text("partial"),
        landed(T0, 100),
        { type: "abort", error: "LLM failed", now: T0 },
      ]);

      expect(writes(effects).at(-1)).toEqual({
        role: "tail",
        messageId: 100,
        text: "partial\n\n⚠️ LLM failed",
        html: false,
      });
    });

    it("sends the abort's tail as a chunk of its own in append-only mode", () => {
      const { effects } = drive(APPEND_ONLY, [
        text("partial"),
        { type: "abort", error: "LLM failed", now: T0 },
      ]);

      expect(writes(effects)).toEqual([
        {
          role: "chunk",
          messageId: undefined,
          text: expect.stringContaining("LLM failed"),
          html: true,
        },
      ]);
    });

    it("takes no content and no second close once closing", () => {
      const closing = drive(EDITS, [text("Hello"), finish]);
      const after = drive(
        EDITS,
        [text("late"), { type: "abort", error: "x", now: T0 }, finish],
        closing.state,
      );

      expect(after).toEqual({ state: closing.state, effects: [] });
    });
  });

  describe("chunks", () => {
    it("writes an overflowing head first, then previews the rest on a new message", () => {
      const opts: StreamOpts = { chunkChars: 150, allowEdits: true };
      const para = "a".repeat(120);
      const { effects } = drive(opts, [
        text("start"),
        landed(T0, 100),
        text(`\n\n${para}\n\n${para}`, T0 + 10),
        landed(T0 + 20),
      ]);

      const [, head, rest] = writes(effects);
      expect(head).toMatchObject({ role: "chunk", messageId: 100, html: true });
      expect(rest).toEqual({ role: "preview", messageId: undefined, text: para, html: false });
    });

    it("writes nothing for a retraction", () => {
      const { effects } = drive(EDITS, [
        text("fragment"),
        landed(T0, 100),
        { type: "retract", text: "fragment", toolUseIds: [] },
      ]);

      expect(writes(effects)).toHaveLength(1);
    });
  });

  describe("crashed", () => {
    it("fails a streaming handle, stopping it", () => {
      const { state } = drive(EDITS, [text("Hello")]);

      expect(crashed(state, "boom")).toEqual({
        state: { kind: "failed", reason: "stream state machine threw: boom" },
        effects: [
          expect.objectContaining({ type: "log", level: "error" }),
          { type: "stopped" },
          { type: "settled", outcome: err("stream state machine threw: boom") },
        ],
      });
    });

    it("fails a closing handle, which has already stopped", () => {
      const { state } = drive(EDITS, [text("Hello"), finish]);

      expect(crashed(state, "boom").effects).not.toContainEqual({ type: "stopped" });
    });

    it("leaves a settled handle as it is", () => {
      expect(crashed({ kind: "done" }, "boom")).toEqual({ state: { kind: "done" }, effects: [] });
    });
  });

  describe("classifyWriteError", () => {
    /** Shaped as grammY's `GrammyError`. */
    function telegramError(code: number, description: string, parameters: object = {}): Error {
      return Object.assign(
        new Error(`Call to 'editMessageText' failed! (${code}: ${description})`),
        {
          error_code: code,
          description,
          parameters,
        },
      );
    }

    it.each([
      [
        "an unmodified edit",
        telegramError(400, "Bad Request: message is not modified"),
        { kind: "not_modified" },
      ],
      [
        "an HTML parse failure",
        telegramError(400, "Bad Request: can't parse entities"),
        { kind: "unparseable", reason: expect.stringContaining("can't parse entities") },
      ],
      [
        "a flood wait",
        telegramError(429, "Too Many Requests: retry after 7", { retry_after: 7 }),
        { kind: "rate_limited", retryAfterMs: 7000, reason: expect.stringContaining("429") },
      ],
      [
        "a 429 without retry_after",
        telegramError(429, "Too Many Requests"),
        { kind: "rejected", reason: expect.stringContaining("429") },
      ],
      [
        "any other API error",
        telegramError(403, "Forbidden: bot was blocked by the user"),
        { kind: "rejected", reason: expect.stringContaining("bot was blocked") },
      ],
      [
        "an edit whose message is gone",
        telegramError(400, "Bad Request: message to edit not found"),
        { kind: "edit_target_gone", reason: expect.stringContaining("not found") },
      ],
      [
        "an edit of a message that can't be edited",
        telegramError(400, "Bad Request: message can't be edited"),
        { kind: "edit_target_gone", reason: expect.stringContaining("can't be edited") },
      ],
      [
        "an edit naming an invalid message id",
        telegramError(400, "Bad Request: MESSAGE_ID_INVALID"),
        { kind: "edit_target_gone", reason: expect.stringContaining("MESSAGE_ID_INVALID") },
      ],
      [
        "a 5xx",
        telegramError(502, "Bad Gateway"),
        { kind: "transient", reason: expect.stringContaining("502") },
      ],
      [
        "a network error",
        Object.assign(new Error("Network request for 'editMessageText' failed!"), {
          name: "HttpError",
        }),
        { kind: "transient", reason: "Network request for 'editMessageText' failed!" },
      ],
      [
        "an error grammY did not raise",
        new Error("fetch failed"),
        { kind: "rejected", reason: "fetch failed" },
      ],
    ])("classifies %s", (_, error, expected) => {
      expect(classifyWriteError(error)).toEqual(expected);
    });
  });

  describe("chunk splitting", () => {
    it("findTelegramSplitBoundary prefers high-quality breaks", () => {
      // Paragraph break wins over later line breaks / spaces.
      const a = `${"a".repeat(2000)}\n\n${"b".repeat(1000)}\n${"c".repeat(1000)}`;
      expect(findTelegramSplitBoundary(a, 3500)).toBe(2002);

      // No paragraph break — falls through to single line break.
      const b = `${"a".repeat(2000)}\n${"b".repeat(2500)}`;
      expect(findTelegramSplitBoundary(b, 3500)).toBe(2001);

      // No newline — sentence boundary.
      const c = `${"a".repeat(1500)}. ${"b".repeat(2500)}`;
      expect(findTelegramSplitBoundary(c, 3500)).toBe(1502);

      // No natural break in the acceptable window → hard split at target.
      const d = "x".repeat(5000);
      expect(findTelegramSplitBoundary(d, 3500)).toBe(3500);

      // Text shorter than target — no split.
      expect(findTelegramSplitBoundary("short", 3500)).toBe(5);

      // Hard split must not land between halves of a surrogate pair —
      // 😀 (U+1F600) is two UTF-16 code units. Cutting at `target` would
      // split it; the helper backs off by one to keep the pair intact.
      const emoji = "😀"; // length 2 in UTF-16
      const e = "x".repeat(99) + emoji + "y".repeat(100);
      // No natural breaks → hard split. target=100 falls on the high
      // surrogate (index 99); helper returns 99 instead.
      expect(findTelegramSplitBoundary(e, 100)).toBe(99);
    });

    it("rebalanceCodeFence closes an open fence on head and reopens on tail", () => {
      // Split lands inside an open fenced block: close + reopen with lang.
      const head = "Here is the code:\n\n```python\ndef foo():\n  return 1";
      const tail = "\nx = foo()\n```\nDone.";
      const out = rebalanceCodeFence(head, tail);
      expect(out.head).toBe(`${head}\n\`\`\``);
      expect(out.tail).toBe(`\`\`\`python\n${tail}`);

      // Already balanced — passthrough.
      const balancedHead = "Code:\n\n```\nx\n```\n\nMore prose.";
      const balancedTail = "Next paragraph.";
      expect(rebalanceCodeFence(balancedHead, balancedTail)).toEqual({
        head: balancedHead,
        tail: balancedTail,
      });

      // No code in head at all — passthrough.
      expect(rebalanceCodeFence("just text", " more")).toEqual({
        head: "just text",
        tail: " more",
      });

      // Fence without a language tag — reopen as bare ```.
      const noLangHead = "```\nplain code\nmore";
      expect(rebalanceCodeFence(noLangHead, "\nstill code").tail).toBe("```\n\nstill code");
    });
  });
});
