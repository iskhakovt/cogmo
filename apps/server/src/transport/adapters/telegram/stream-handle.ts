import { type Bot, InputFile } from "grammy";
import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { parseGeneratedDocumentPayload } from "../../../agent/document-tools.js";
import { parseGeneratedImagePayload } from "../../../agent/image-tools.js";
import type { StreamEvent } from "../../../llm/types.js";
import { logger } from "../../../logger.js";
import { type AttachmentStore, mediaTypeToExt } from "../../attachment-store.js";
import type { StreamHandle, StreamOpts } from "../../types.js";
import {
  classifyWriteError,
  type Effect,
  type StreamInput,
  type StreamState,
  transition,
  type Write,
} from "./stream-state.js";

/**
 * Refresh interval for append-only mode's `sendChatAction("typing")`
 * heartbeat. Telegram clears the indicator after about 5s; 3.5s refreshes it
 * inside that window.
 */
const TELEGRAM_TYPING_REFRESH_MS = 3500;

/** A tool result delivered as a photo or file rather than rendered. */
type MediaResult = Extract<StreamEvent, { type: "tool_result" }> & {
  name: "generate_image" | "send_document";
};

function isMediaResult(event: StreamEvent): event is MediaResult {
  return (
    event.type === "tool_result" &&
    (event.name === "generate_image" || event.name === "send_document") &&
    !event.isError
  );
}

/** A file to send for a media result. */
interface Media {
  kind: "photo" | "document";
  path: string;
  filename: string;
}

/** The file a media result names, or null when its payload is malformed. */
function mediaOf(event: MediaResult): Media | null {
  if (event.name === "generate_image") {
    const image = parseGeneratedImagePayload(event.output);
    return (
      image && {
        kind: "photo",
        path: image.path,
        filename: `image.${mediaTypeToExt(image.mediaType)}`,
      }
    );
  }
  const document = parseGeneratedDocumentPayload(event.output);
  return document && { kind: "document", path: document.path, filename: document.name };
}

/** A stream handle that tells when it has settled. */
export interface SettlingStreamHandle extends StreamHandle {
  /** Resolves once the stream is done, or with why it failed. */
  readonly done: Promise<Result<void, string>>;
}

/**
 * One turn's stream into one Telegram chat. Drives the machine in
 * `stream-state.ts`: puts every push, lifecycle call and write result to
 * `transition` and carries out the effects it returns. The machine starts at
 * most one write at a time, and each write's result goes back into it, so
 * the writes form a single queue in the order the machine decides.
 *
 * `push` resolves once no write is in flight, and errs once the handle has
 * failed. `finish` and `abort` resolve with `done`.
 *
 * Generated images and documents go out mid-stream via `sendPhoto` /
 * `sendDocument`, once per path: a push that repeats one — an Inngest retry
 * re-emitting it — sends nothing.
 */
export class TelegramStreamHandle implements SettlingStreamHandle {
  readonly #bot: Bot;
  readonly #attachments: AttachmentStore;
  readonly #chatId: number;
  readonly #opts: StreamOpts;
  readonly #log: typeof logger;
  #state: StreamState = { kind: "idle" };
  readonly #settled = Promise.withResolvers<Result<void, string>>();
  readonly done: Promise<Result<void, string>> = this.#settled.promise;
  /** Aborted once the stream takes no more content; the typing heartbeat stops with it. */
  readonly #live = new AbortController();
  /** The write Telegram is carrying; settles once its result is back in the machine. */
  #inFlight: Promise<void> | null = null;
  /** The pending `retry_after` wait. */
  #wait: ReturnType<typeof setTimeout> | null = null;
  /** Paths of media already delivered. */
  readonly #sentMedia = new Set<string>();

  constructor(
    bot: Bot,
    attachments: AttachmentStore,
    chatId: number,
    runId: string,
    opts: StreamOpts,
  ) {
    this.#bot = bot;
    this.#attachments = attachments;
    this.#chatId = chatId;
    this.#opts = opts;
    this.#log = logger.child({ component: "telegram.stream", runId });
  }

  async push(event: StreamEvent): Promise<Result<void, string>> {
    if (this.#state.kind === "done" || this.#state.kind === "failed") return this.#outcome();
    if (event.type === "retract") {
      this.#input({ type: "retract", text: event.text, toolUseIds: event.toolUseIds });
    } else if (isMediaResult(event)) {
      await this.#sendMedia(event);
    } else {
      this.#input({ type: "push", event, now: Date.now() });
    }
    while (this.#inFlight !== null) await this.#inFlight;
    return this.#outcome();
  }

  async finish(): Promise<Result<void, string>> {
    this.#input({ type: "finish", now: Date.now() });
    return this.done;
  }

  async abort(error: string): Promise<Result<void, string>> {
    this.#input({ type: "abort", error, now: Date.now() });
    return this.done;
  }

  #outcome(): Result<void, string> {
    return this.#state.kind === "failed" ? err(this.#state.reason) : ok(undefined);
  }

  #input(input: StreamInput): void {
    const next = transition(this.#state, input, this.#opts);
    this.#state = next.state;
    for (const effect of next.effects) this.#execute(effect);
  }

  #execute(effect: Effect): void {
    match(effect)
      .with({ type: "write" }, ({ write }) => this.#write(write))
      .with({ type: "wait" }, ({ ms }) => {
        this.#wait = setTimeout(() => {
          this.#wait = null;
          this.#input({ type: "throttle_elapsed", now: Date.now() });
        }, ms);
        this.#wait.unref();
      })
      .with({ type: "start_typing" }, () => this.#startTyping())
      .with({ type: "stopped" }, () => this.#live.abort())
      .with({ type: "settled" }, ({ outcome }) => {
        if (this.#wait !== null) clearTimeout(this.#wait);
        this.#settled.resolve(outcome);
      })
      .with({ type: "log" }, ({ level, message, fields }) => this.#log[level](fields, message))
      .exhaustive();
  }

  /** Start `write` and put its result back into the machine. */
  #write(write: Write): void {
    const flight = this.#call(write)
      .then(
        (messageId): StreamInput => ({ type: "api_ok", messageId, now: Date.now() }),
        (e: unknown): StreamInput => ({
          type: "api_failed",
          failure: classifyWriteError(e),
          now: Date.now(),
        }),
      )
      .then((result) => {
        this.#inFlight = null;
        this.#input(result);
      });
    this.#inFlight = flight;
  }

  /** Send or edit; resolves with the id of a message it sent. */
  async #call(write: Write): Promise<number | undefined> {
    const api = this.#bot.api;
    const html = { parse_mode: "HTML" } as const;
    if (write.messageId === undefined) {
      const sent = write.html
        ? await api.sendMessage(this.#chatId, write.text, html)
        : await api.sendMessage(this.#chatId, write.text);
      return sent.message_id;
    }
    if (write.html) await api.editMessageText(this.#chatId, write.messageId, write.text, html);
    else await api.editMessageText(this.#chatId, write.messageId, write.text);
    return undefined;
  }

  /**
   * Typing is a hint, not load-bearing: a failed kick is logged at `debug`
   * (a busy Bot API produces them in bursts) and the heartbeat carries on.
   */
  #startTyping(): void {
    const signal = this.#live.signal;
    if (signal.aborted) return;
    const kick = (): void => {
      this.#bot.api.sendChatAction(this.#chatId, "typing").catch((err: unknown) => {
        this.#log.debug({ err }, "telegram: sendChatAction(typing) failed; heartbeat continues");
      });
    };
    kick();
    const timer = setInterval(kick, TELEGRAM_TYPING_REFRESH_MS);
    timer.unref();
    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  }

  /**
   * Deliver a generated image or document, then drop its tool banner from the
   * buffer. A failure is logged and leaves the path unmarked, so a retry that
   * re-emits the result tries again; the text stream carries on either way.
   */
  async #sendMedia(event: MediaResult): Promise<void> {
    const media = mediaOf(event);
    if (media === null) {
      this.#log.warn(`telegram: ${event.name} tool_result didn't match expected payload shape`);
      return;
    }
    if (this.#sentMedia.has(media.path)) return;
    try {
      const file = new InputFile(await this.#attachments.download(media.path), media.filename);
      if (media.kind === "photo") await this.#bot.api.sendPhoto(this.#chatId, file);
      else await this.#bot.api.sendDocument(this.#chatId, file);
    } catch (err) {
      this.#log.error({ err, path: media.path }, `telegram: failed to deliver ${event.name}`);
      return;
    }
    this.#sentMedia.add(media.path);
    this.#input({ type: "media_sent", toolName: event.name });
  }
}
