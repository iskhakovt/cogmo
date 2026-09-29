import { err, ok, type Result } from "neverthrow";
import { match, P } from "ts-pattern";
import { z } from "zod";
import type { StreamEvent } from "../../../llm/types.js";
import { describeError } from "../../../util/describe-error.js";
import type { RenderedMessage } from "../../adapter-module.js";
import type { StreamOpts } from "../../types.js";
import { renderTelegramHtml } from "./render.js";

/**
 * One Telegram stream handle as a pure state machine. `transition` takes every
 * input — the caller's pushes and lifecycle calls, and the result of each
 * write it asked for — and returns the next state and the effects to carry
 * out. `TelegramStreamHandle` feeds it and runs the effects. See
 * `design/transport/streaming.md` → Telegram stream handle.
 *
 * ```
 *  idle ─push─► streaming ─finish · abort─► finalizing ─last write lands─► done
 *   │                │                           │
 *   │                └──── a write fails ────────┴──────────────────────► failed
 *   └─finish─► done
 * ```
 *
 * An abort from `idle` enters `finalizing` too, to write the error alone.
 *
 * Invariants the table enforces:
 *  - at most one write is in flight, and none starts during a wait before a
 *    retry;
 *  - chunks are written in the order they were cut, each ahead of any later text;
 *  - a write that must land — a chunk, the abort's error tail — is retried
 *    after a rate limit or a transient failure, and falls back to plain text
 *    when Telegram rejects its HTML;
 *  - when the message a write edits is gone, the stream carries on in a new
 *    message; any other failure fails the handle;
 *  - `done` and `failed` are final and ignore every input.
 */

/** Telegram's cap on one message's text. */
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
/** Minimum time between two previews of the live message. */
export const EDIT_INTERVAL_MS = 500;
/** Longest single wait before a retry; a longer `retry_after` fails the handle at once. */
export const MAX_WAIT_MS = 30_000;
/**
 * Longest a closing stream spends, from `finish` or `abort`, before its last
 * wait ends: a wait that would end later fails the handle instead. The close
 * holds up the turn, and a stream that fails at finish gets its reply again
 * through a delivery step, whose retries hold up nothing. 60s allows two of
 * the longest waits, or a whole transient backoff with room for the writes.
 */
const MAX_CLOSE_MS = 60_000;
/** Failed writes in a row, rate limits and transient failures alike, at which the handle fails. */
export const MAX_FAILURES_IN_A_ROW = 5;
/** Wait after a first transient failure; each further one in a row doubles it. */
const TRANSIENT_BACKOFF_MS = 1000;
/**
 * Floor on the head of a split: anything shorter makes a sliver of a message,
 * so the split cuts later in the source instead. About 3-4 lines in the mobile
 * UI. At low per-profile targets the floor is `target / 4` instead.
 */
const TELEGRAM_MIN_HEAD_CHARS = 500;

/**
 * One appended piece of the live message, tagged with where it came from.
 *
 * The buffer is a list rather than a string because a retraction names an
 * iteration's text and its tool calls, and that text is not contiguous in the
 * rendered message: a tool banner sits between the deltas that came before the
 * call and the ones after it. Searching the rendered string for the named text
 * finds nothing in that case, and cannot tell "this was interleaved" apart from
 * "this was already flushed into its own message" — one wants a partial cut,
 * the other wants none.
 */
type BufferSegment =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolUseId: string; toolName: string; text: string }
  | { kind: "status"; text: string };

/** A finished chunk awaiting its write. */
interface Chunk {
  source: string;
  /** Telegram rejected its HTML render: write the source as it is. */
  plain: boolean;
}

/**
 * What a write is for:
 *  - `preview`: the live message so far, in plain text; the next one supersedes it.
 *  - `chunk`: `chunks[0]`, rendered; it must land, and freezes its message.
 *  - `tail`: the abort's error tail, in plain text, on the live message; it must land.
 */
type WriteRole = "preview" | "chunk" | "tail";

/** A write to Telegram. */
export interface Write {
  role: WriteRole;
  /** The message to edit; absent, a new message is sent. */
  messageId: number | undefined;
  text: string;
  /** Send with `parse_mode: "HTML"`. */
  html: boolean;
}

/** The stream while it has a live message. */
interface Live {
  /** The message writes edit; absent until the first is sent, and after a chunk freezes it. */
  messageId: number | undefined;
  /** The editable buffer: what the live message is to show. */
  segments: ReadonlyArray<BufferSegment>;
  /** Chunks cut from the head of the buffer, oldest first, each still to be written. */
  chunks: ReadonlyArray<Chunk>;
  /** When the live message was last previewed; 0 once a chunk has frozen it. */
  lastEditAt: number;
  /** The live message's text as last written. */
  shown: string;
  /** The write Telegram is carrying. */
  inFlight: Write | null;
  /** A wait before a retry is running: nothing is written until `throttle_elapsed`. */
  waiting: boolean;
  /** Writes that have failed in a row and been waited out. */
  failedInARow: number;
}

/** How the stream closes. An abort's error tail is already in the buffer. */
type Closing = "finish" | "abort";

export type StreamState =
  | { kind: "idle" }
  | ({ kind: "streaming" } & Live)
  | ({ kind: "finalizing"; closing: Closing; closedAt: number } & Live)
  | { kind: "done" }
  | { kind: "failed"; reason: string };

type Open = Extract<StreamState, { kind: "streaming" | "finalizing" }>;

/** Why a write failed, as far as the machine tells failures apart. */
type WriteFailure =
  /** An edit that changes nothing: the message already shows the text. */
  | { kind: "not_modified" }
  /** Telegram could not parse the HTML. */
  | { kind: "unparseable"; reason: string }
  | { kind: "rate_limited"; retryAfterMs: number; reason: string }
  /** A 5xx, or a request that never got an answer. */
  | { kind: "transient"; reason: string }
  /** The message an edit names is gone, or can no longer be edited. */
  | { kind: "edit_target_gone"; reason: string }
  | { kind: "rejected"; reason: string };

/** A stream event the machine renders; retractions and media have inputs of their own. */
type RenderedEvent = Exclude<StreamEvent, { type: "retract" }>;

export type StreamInput =
  | { type: "push"; event: RenderedEvent; now: number }
  | { type: "retract"; text: string; toolUseIds: ReadonlyArray<string> }
  /** A tool's output went out as a photo or file: its banner goes. */
  | { type: "media_sent"; toolName: string }
  | { type: "api_ok"; messageId: number | undefined; now: number }
  | { type: "api_failed"; failure: WriteFailure; now: number }
  /** A wait before a retry has passed. */
  | { type: "throttle_elapsed"; now: number }
  | { type: "finish"; now: number }
  | { type: "abort"; error: string; now: number };

export type Effect =
  | { type: "write"; write: Write }
  /** Feed `throttle_elapsed` after `ms`. */
  | { type: "wait"; ms: number }
  /** Append-only mode's progress hint, from the first push. */
  | { type: "start_typing" }
  /** The stream takes no more content: the typing heartbeat stops. Emitted once. */
  | { type: "stopped" }
  /** Entered `done` or `failed`. Emitted once. */
  | { type: "settled"; outcome: Result<void, string> }
  | {
      type: "log";
      level: "error" | "warn" | "debug";
      message: string;
      fields: Record<string, unknown>;
    };

export interface Transition {
  state: StreamState;
  effects: ReadonlyArray<Effect>;
}

export function transition(state: StreamState, input: StreamInput, opts: StreamOpts): Transition {
  return (
    match<[StreamState, StreamInput], Transition>([state, input])
      .with([{ kind: P.union("done", "failed") }, P._], ([s]) => stay(s))
      .with([{ kind: "idle" }, { type: "push" }], ([, { event, now }]) =>
        onPush(open(), event, opts, now, opts.allowEdits ? [] : [{ type: "start_typing" }]),
      )
      .with([{ kind: "streaming" }, { type: "push" }], ([s, { event, now }]) =>
        onPush(s, event, opts, now, []),
      )
      .with([{ kind: "streaming" }, { type: "retract" }], ([s, { text, toolUseIds }]) =>
        stay({ ...s, segments: retract(s.segments, text, new Set(toolUseIds)) }),
      )
      .with([{ kind: "streaming" }, { type: "media_sent" }], ([s, { toolName }]) =>
        stay({
          ...s,
          segments: s.segments.filter((g) => !(g.kind === "tool" && g.toolName === toolName)),
        }),
      )
      .with([{ kind: "idle" }, { type: "finish" }], () =>
        settle({ kind: "done" }, ok(undefined), true),
      )
      .with([{ kind: "idle" }, { type: "abort" }], ([, { error, now }]) =>
        onAbort(open(), error, opts, now),
      )
      .with([{ kind: "streaming" }, { type: "finish" }], ([s, { now }]) => onFinish(s, opts, now))
      .with([{ kind: "streaming" }, { type: "abort" }], ([s, { error, now }]) =>
        onAbort(s, error, opts, now),
      )
      .with(
        [{ kind: P.union("streaming", "finalizing") }, { type: "api_ok" }],
        ([s, { messageId, now }]) => onWritten(s, messageId, opts, now),
      )
      .with(
        [{ kind: P.union("streaming", "finalizing") }, { type: "api_failed" }],
        ([s, { failure, now }]) => onWriteFailed(s, failure, opts, now),
      )
      .with(
        [{ kind: P.union("streaming", "finalizing") }, { type: "throttle_elapsed" }],
        ([s, { now }]) => advance({ ...s, waiting: false }, opts, now, []),
      )
      // A closing stream takes no more content, and closes once.
      .with(
        [
          { kind: "finalizing" },
          { type: P.union("push", "retract", "media_sent", "finish", "abort") },
        ],
        ([s]) => stay(s),
      )
      // Nothing is on screen and no write is due before the first push.
      .with(
        [
          { kind: "idle" },
          { type: P.union("retract", "media_sent", "api_ok", "api_failed", "throttle_elapsed") },
        ],
        ([s]) => stay(s),
      )
      .exhaustive()
  );
}

/**
 * The machine threw on an input — a bug. Fail the handle rather than leave it
 * waiting on a write whose result the machine never took.
 */
export function crashed(state: StreamState, reason: string): Transition {
  if (state.kind === "done" || state.kind === "failed") return stay(state);
  const failure = `stream state machine threw: ${reason}`;
  return settle({ kind: "failed", reason: failure }, err(failure), state.kind !== "finalizing", [
    logEffect("error", "telegram: stream state machine threw — the handle stops", { reason }),
  ]);
}

/**
 * Classify a failed Bot API call the way grammY's auto-retry plugin does: an
 * answer carrying `retry_after` is a rate limit; a `GrammyError` with a 5xx
 * `error_code`, or an `HttpError` (the request got no answer), is transient.
 * Anything else is a rejection.
 */
export function classifyWriteError(error: unknown): WriteFailure {
  const reason = describeError(error);
  if (reason.includes("message is not modified")) return { kind: "not_modified" };
  if (reason.includes("can't parse entities")) return { kind: "unparseable", reason };
  if (EDIT_TARGET_GONE.some((description) => reason.includes(description))) {
    return { kind: "edit_target_gone", reason };
  }
  const answer = BotApiErrorSchema.safeParse(error);
  const retryAfter = answer.success ? answer.data.parameters?.retry_after : undefined;
  if (retryAfter !== undefined)
    return { kind: "rate_limited", retryAfterMs: retryAfter * 1000, reason };
  if (answer.success && answer.data.error_code >= 500) return { kind: "transient", reason };
  if (HttpErrorSchema.safeParse(error).success) return { kind: "transient", reason };
  return { kind: "rejected", reason };
}

/** Bot API descriptions of an edit whose message is gone or no longer editable. */
const EDIT_TARGET_GONE = [
  "message to edit not found",
  "message can't be edited",
  "MESSAGE_ID_INVALID",
] as const;

/** The fields of grammY's `GrammyError` the classification reads. */
const BotApiErrorSchema = z.object({
  error_code: z.number(),
  parameters: z.object({ retry_after: z.number().nonnegative().optional() }).optional(),
});

/** grammY's `HttpError`, which names itself. */
const HttpErrorSchema = z.object({ name: z.literal("HttpError") });

/**
 * If `head` ends inside an open fenced code block, close the fence at the
 * end of `head` and re-open it at the start of `tail` with the same language
 * tag. Otherwise return the pair unchanged. Indented (non-fenced) code
 * blocks need no rebalancing — they have no delimiters.
 *
 * Scope: backtick fences only, recognised on a line with no leading indent.
 * Tilde fences (~~~) and indented fences (up to 3 leading spaces under
 * CommonMark) aren't handled — they're vanishingly rare in LLM output. The
 * scan toggles on each fence line, which matches CommonMark when the document
 * only uses 3-backtick fences. Inline single-backtick code spans (\`like
 * this\`) are also out of scope — a split inside one leaks a literal backtick
 * at the boundary.
 */
export function rebalanceCodeFence(head: string, tail: string): { head: string; tail: string } {
  const fenceLineRe = /^(?:`{3,})(\w*)/;
  let inFence = false;
  let fenceLang = "";
  for (const line of head.split("\n")) {
    const m = line.match(fenceLineRe);
    if (!m) continue;
    if (!inFence) {
      inFence = true;
      fenceLang = m[1] ?? "";
    } else {
      inFence = false;
      fenceLang = "";
    }
  }
  if (!inFence) return { head, tail };
  const closedHead = head.endsWith("\n") ? `${head}\`\`\`` : `${head}\n\`\`\``;
  const opener = fenceLang ? `\`\`\`${fenceLang}\n` : "```\n";
  const openedTail = `${opener}${tail}`;
  return { head: closedHead, tail: openedTail };
}

/**
 * Find a clean split point in `text` no later than `target`. Prefers higher-
 * quality boundaries (paragraph > line > sentence > word) and falls back to a
 * hard char split if no break exists in [TELEGRAM_MIN_HEAD_CHARS, target].
 * The returned index is the slice point — `text.slice(0, idx)` is the head,
 * the rest is the tail.
 */
export function findTelegramSplitBoundary(text: string, target: number): number {
  if (text.length <= target) return text.length;
  const minIdx = Math.min(TELEGRAM_MIN_HEAD_CHARS, Math.floor(target * 0.25));
  for (const sep of ["\n\n", "\n", ". ", "! ", "? ", " "]) {
    const idx = text.lastIndexOf(sep, target - sep.length);
    if (idx >= minIdx) return idx + sep.length;
  }
  // No natural break — hard cut. JS strings index UTF-16 code units; never
  // slice between the two halves of a surrogate pair, or Telegram receives
  // malformed UTF-8 and rejects the message.
  let idx = target;
  const code = text.charCodeAt(idx - 1);
  if (code >= 0xd800 && code <= 0xdbff) idx -= 1;
  return idx;
}

/**
 * Split `text` into parts that each fit one Telegram message, at the
 * cleanest breaks `findTelegramSplitBoundary` finds. The break's whitespace
 * ends its part and is trimmed off.
 */
export function splitAtCap(text: string): ReadonlyArray<string> {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
    const splitIdx = findTelegramSplitBoundary(rest, TELEGRAM_MAX_MESSAGE_LENGTH);
    parts.push(rest.slice(0, splitIdx).trimEnd());
    rest = rest.slice(splitIdx);
  }
  return [...parts, rest];
}

// --- inputs ---

function onPush(
  state: Extract<StreamState, { kind: "streaming" }>,
  event: RenderedEvent,
  opts: StreamOpts,
  now: number,
  effects: ReadonlyArray<Effect>,
): Transition {
  const segment = segmentFor(event, opts.allowEdits);
  const segments = segment === null ? state.segments : [...state.segments, segment];
  return advance(withOverflowCut({ ...state, segments }, opts), opts, now, effects);
}

/** Close with what the buffer holds: every remaining chunk is written, the last rendered. */
function onFinish(
  state: Extract<StreamState, { kind: "streaming" }>,
  opts: StreamOpts,
  now: number,
): Transition {
  const cut = withOverflowCut(state, opts);
  return advance(
    { ...cut, kind: "finalizing", closing: "finish", closedAt: now, ...flushed(cut) },
    opts,
    now,
    [{ type: "stopped" }],
  );
}

/**
 * Close with the error appended to what the buffer holds. Edit mode writes
 * that tail onto the live message in plain text; append-only mode, which never
 * edits, sends it as a chunk of its own.
 */
function onAbort(
  state: Extract<StreamState, { kind: "streaming" }>,
  error: string,
  opts: StreamOpts,
  now: number,
): Transition {
  const buffered = textOf(state.segments);
  const tail = buffered ? `${buffered}\n\n⚠️ ${error}` : `⚠️ ${error}`;
  const cut = withOverflowCut({ ...state, segments: [{ kind: "text", text: tail }] }, opts);
  return advance(
    {
      ...cut,
      kind: "finalizing",
      closing: "abort",
      closedAt: now,
      ...(opts.allowEdits ? {} : flushed(cut)),
    },
    opts,
    now,
    [{ type: "stopped" }],
  );
}

function onWritten(
  state: Open,
  messageId: number | undefined,
  opts: StreamOpts,
  now: number,
): Transition {
  const write = state.inFlight;
  if (write === null) return stayAndLog(state, "warn", "write result with no write in flight", {});
  const landed = { ...state, inFlight: null, failedInARow: 0 };
  const next = match(write.role)
    .returnType<Open>()
    .with("preview", () => ({
      ...landed,
      messageId: write.messageId ?? messageId,
      shown: write.text,
      lastEditAt: now,
    }))
    .with("chunk", () => ({
      ...landed,
      chunks: landed.chunks.slice(1),
      messageId: undefined,
      shown: "",
      // The next message's first preview goes out at once.
      lastEditAt: 0,
    }))
    .with("tail", () => ({ ...landed, segments: [] }))
    .exhaustive();
  return advance(next, opts, now, []);
}

function onWriteFailed(
  state: Open,
  failure: WriteFailure,
  opts: StreamOpts,
  now: number,
): Transition {
  const write = state.inFlight;
  if (write === null) return stayAndLog(state, "warn", "write result with no write in flight", {});
  return match(failure)
    .returnType<Transition>()
    .with({ kind: "not_modified" }, () => onWritten(state, undefined, opts, now))
    .with({ kind: "unparseable" }, ({ reason }) => {
      const [chunk, ...rest] = state.chunks;
      if (write.role !== "chunk" || !write.html || chunk === undefined) return fail(state, reason);
      // Put the plain body on the surface on both paths: a retraction may have
      // cut what the previews wrote out of this chunk, so the message can't be
      // trusted to show it already.
      return advance(
        { ...state, inFlight: null, chunks: [{ ...chunk, plain: true }, ...rest] },
        opts,
        now,
        [logEffect("warn", "telegram: chunk HTML parse failed, retrying as plain text", {})],
      );
    })
    .with({ kind: "rate_limited" }, ({ retryAfterMs, reason }) =>
      waitToRetry(state, write, retryAfterMs, reason, now),
    )
    .with({ kind: "transient" }, ({ reason }) =>
      waitToRetry(state, write, TRANSIENT_BACKOFF_MS * 2 ** state.failedInARow, reason, now),
    )
    .with({ kind: "edit_target_gone" }, ({ reason }) => {
      // The stream carries on in a new message: a chunk or tail stays due, and
      // a preview gives way to the next, both now sends. The user is left with
      // the whole reply rather than a cut-short one. A send can't fail this
      // way, so each lost message costs one resend.
      if (write.messageId === undefined) return fail(state, reason);
      return advance({ ...state, inFlight: null, messageId: undefined }, opts, now, [
        logEffect("warn", "telegram: message to edit is gone, sending the rest as a new one", {
          reason,
        }),
      ]);
    })
    .with({ kind: "rejected" }, ({ reason }) => fail(state, reason))
    .exhaustive();
}

/**
 * Wait `ms`, then carry on: a preview is not repeated, since the next one
 * after the wait carries the latest text, while a chunk or tail stays due and
 * goes again. Fails instead past the longest wait, the failures in a row, or
 * a closing stream's time.
 */
function waitToRetry(
  state: Open,
  write: Write,
  ms: number,
  reason: string,
  now: number,
): Transition {
  if (ms > MAX_WAIT_MS)
    return fail(state, `a ${ms}ms wait is longer than the stream waits: ${reason}`);
  if (state.kind === "finalizing" && now + ms > state.closedAt + MAX_CLOSE_MS) {
    return fail(state, `closing would take longer than ${MAX_CLOSE_MS}ms: ${reason}`);
  }
  const failedInARow = state.failedInARow + 1;
  if (failedInARow >= MAX_FAILURES_IN_A_ROW) {
    return fail(state, `${failedInARow} writes failed in a row: ${reason}`);
  }
  return step({ ...state, inFlight: null, waiting: true, failedInARow }, [
    { type: "wait", ms },
    logEffect("debug", "telegram: write failed, waiting to retry", {
      role: write.role,
      ms,
      reason,
    }),
  ]);
}

// --- deciding the next write ---

/**
 * Start the next write, if one is due and none is in flight: chunks first, in
 * order; then, once closing, the abort's tail or nothing — the stream is done;
 * otherwise a preview, when edits are on, the text has changed and the edit
 * interval has passed since the last one.
 */
function advance(
  state: Open,
  opts: StreamOpts,
  now: number,
  effects: ReadonlyArray<Effect>,
): Transition {
  if (state.inFlight !== null || state.waiting) return step(state, effects);
  const [chunk] = state.chunks;
  if (chunk !== undefined) {
    const rendered = chunkWrite(state.messageId, chunk);
    return writing(state, rendered.write, [...effects, ...rendered.effects]);
  }
  const text = textOf(state.segments);
  if (state.kind === "finalizing") {
    if (text === "") return settle({ kind: "done" }, ok(undefined), false, effects);
    return writing(state, { role: "tail", messageId: state.messageId, text, html: false }, effects);
  }
  const due =
    opts.allowEdits &&
    text !== "" &&
    text !== state.shown &&
    now - state.lastEditAt >= EDIT_INTERVAL_MS;
  if (!due) return step(state, effects);
  return writing(
    state,
    { role: "preview", messageId: state.messageId, text, html: false },
    effects,
  );
}

/**
 * A chunk's write: rendered to Telegram's HTML when that fits, its source
 * otherwise. A render that throws gets the source too, as one Telegram can't
 * parse does.
 */
function chunkWrite(
  messageId: number | undefined,
  chunk: Chunk,
): { write: Write; effects: ReadonlyArray<Effect> } {
  const plain: Write = { role: "chunk", messageId, text: chunk.source, html: false };
  if (chunk.plain) return { write: plain, effects: [] };
  let rendered: RenderedMessage;
  try {
    rendered = renderTelegramHtml(chunk.source);
  } catch (e) {
    const reason = describeError(e);
    return {
      write: plain,
      effects: [
        logEffect("warn", "telegram: chunk HTML render failed, writing plain text", { reason }),
      ],
    };
  }
  const fits =
    rendered.parseMode !== undefined && rendered.text.length <= TELEGRAM_MAX_MESSAGE_LENGTH;
  return {
    write: fits ? { role: "chunk", messageId, text: rendered.text, html: true } : plain,
    effects: [],
  };
}

// --- the buffer ---

function segmentFor(event: RenderedEvent, allowEdits: boolean): BufferSegment | null {
  return (
    match(event)
      .returnType<BufferSegment | null>()
      .with({ type: "text_delta" }, ({ text }) => (text ? { kind: "text", text } : null))
      // Append-only mode drops in-message banners: they would land mid-paragraph
      // at the next chunk boundary, stale. The typing heartbeat carries progress.
      .with({ type: "tool_start" }, ({ id, name }) =>
        allowEdits
          ? { kind: "tool", toolUseId: id, toolName: name, text: `\n🔍 ${name}...\n` }
          : null,
      )
      .with({ type: "status" }, ({ message }) =>
        allowEdits ? { kind: "status", text: `\n⏳ ${message}\n` } : null,
      )
      // Tool results go unrendered — the model summarizes them — and thinking
      // is not part of the reply (design/transport/streaming.md → Stream Events).
      .with({ type: P.union("tool_result", "thinking_delta") }, () => null)
      .exhaustive()
  );
}

function textOf(segments: ReadonlyArray<BufferSegment>): string {
  return segments.map((segment) => segment.text).join("");
}

/**
 * Cut chunks off the head of the buffer until what remains fits
 * `chunkChars`. A split inside a code fence closes the fence on the head and
 * reopens it on what remains.
 */
function withOverflowCut<S extends Open>(state: S, opts: StreamOpts): S {
  let segments = state.segments;
  const heads: Chunk[] = [];
  let buffered = textOf(segments);
  while (buffered.length > opts.chunkChars) {
    const splitIdx = findTelegramSplitBoundary(buffered, opts.chunkChars);
    const rawTail = buffered.slice(splitIdx);
    const { head, tail } = rebalanceCodeFence(buffered.slice(0, splitIdx), rawTail);
    // Rebalancing only ever prepends a re-opening fence to the tail, so the
    // difference is a new head for the buffer rather than an edit inside it.
    const reopened = tail.slice(0, tail.length - rawTail.length);
    const rest = consumePrefix(segments, splitIdx);
    segments = reopened ? [{ kind: "text", text: reopened }, ...rest] : rest;
    heads.push({ source: head, plain: false });
    buffered = textOf(segments);
  }
  return heads.length === 0 ? state : { ...state, segments, chunks: [...state.chunks, ...heads] };
}

/** The whole buffer, as the last chunk. */
function flushed(state: Open): Pick<Live, "segments" | "chunks"> {
  const source = textOf(state.segments);
  return {
    segments: [],
    chunks: source ? [...state.chunks, { source, plain: false }] : state.chunks,
  };
}

/** Drop the first `count` characters, splitting whichever segment straddles them. */
function consumePrefix(
  segments: ReadonlyArray<BufferSegment>,
  count: number,
): ReadonlyArray<BufferSegment> {
  let remaining = count;
  const kept: BufferSegment[] = [];
  for (const segment of segments) {
    if (remaining >= segment.text.length) {
      remaining -= segment.text.length;
    } else {
      kept.push(remaining > 0 ? { ...segment, text: segment.text.slice(remaining) } : segment);
      remaining = 0;
    }
  }
  return kept;
}

/**
 * Remove the named text and tool banners, plus everything the buffer holds
 * after them.
 *
 * A retraction always names the tail of the stream — the iteration the turn
 * won't persist — so the cut is the earliest point that iteration touched:
 * whichever comes first, its first named tool banner or the start of its
 * text. Everything from there is that same iteration's, banners included.
 * Content before the cut belongs to iterations that are persisted and stays.
 *
 * When the named text is longer than what the buffer still holds, the rest
 * has already been cut into a chunk of its own, which Telegram gives no
 * handle to edit back: the editable remainder is entirely retracted content,
 * so the buffer empties and the chunk stands. An empty `text` (a degrade that
 * streamed no prose) cuts at the named banners alone. The message id is kept,
 * so the next write replaces the fragment on screen rather than trailing it.
 */
function retract(
  segments: ReadonlyArray<BufferSegment>,
  text: string,
  toolUseIds: ReadonlySet<string>,
): ReadonlyArray<BufferSegment> {
  const namedBanner = segments.findIndex(
    (segment) => segment.kind === "tool" && toolUseIds.has(segment.toolUseId),
  );

  let remaining = text.length;
  let textCut = segments.length;
  let keptPrefix: string | null = null;
  for (let i = segments.length - 1; i >= 0 && remaining > 0; i--) {
    const segment = segments[i];
    if (segment === undefined) continue;
    if (segment.kind !== "text") {
      // A banner between two of the retracted iteration's deltas. It isn't
      // part of the named text, but it is inside the region being cut.
      textCut = i;
      continue;
    }
    if (segment.text.length <= remaining) {
      remaining -= segment.text.length;
      textCut = i;
    } else {
      keptPrefix = segment.text.slice(0, segment.text.length - remaining);
      textCut = i;
      remaining = 0;
    }
  }

  const cut = namedBanner === -1 ? textCut : Math.min(namedBanner, textCut);
  const kept = segments.slice(0, cut);
  // The partial segment is only half-retracted, so its surviving prefix goes
  // back — unless a named banner cut earlier still, which puts the whole
  // segment inside the retracted region.
  return keptPrefix !== null && textCut === cut
    ? [...kept, { kind: "text", text: keptPrefix }]
    : kept;
}

// --- helpers ---

function open(): Extract<StreamState, { kind: "streaming" }> {
  return {
    kind: "streaming",
    messageId: undefined,
    segments: [],
    chunks: [],
    lastEditAt: 0,
    shown: "",
    inFlight: null,
    waiting: false,
    failedInARow: 0,
  };
}

function writing(state: Open, write: Write, effects: ReadonlyArray<Effect>): Transition {
  return step({ ...state, inFlight: write }, [...effects, { type: "write", write }]);
}

function fail(state: Open, reason: string): Transition {
  return settle({ kind: "failed", reason }, err(reason), state.kind === "streaming", [
    logEffect("warn", "telegram: stream write failed — the handle stops", { reason }),
  ]);
}

/** Enter a final state. `stopping`: the stream was still taking content, so it stops now. */
function settle(
  state: Extract<StreamState, { kind: "done" | "failed" }>,
  outcome: Result<void, string>,
  stopping: boolean,
  effects: ReadonlyArray<Effect> = [],
): Transition {
  return step(state, [
    ...effects,
    ...(stopping ? [{ type: "stopped" } as const] : []),
    { type: "settled", outcome },
  ]);
}

function step(state: StreamState, effects: ReadonlyArray<Effect>): Transition {
  return { state, effects };
}

function stay(state: StreamState): Transition {
  return step(state, []);
}

function stayAndLog(
  state: StreamState,
  level: LogEffect["level"],
  message: string,
  fields: Record<string, unknown>,
): Transition {
  return step(state, [logEffect(level, message, fields)]);
}

type LogEffect = Extract<Effect, { type: "log" }>;

function logEffect(
  level: LogEffect["level"],
  message: string,
  fields: Record<string, unknown>,
): LogEffect {
  return { type: "log", level, message, fields };
}
