/** The running adapter: outbound delivery, stream handles, voice, polling supervision, and a shutdown that confirms handled updates. */

import { type Bot, GrammyError, InputFile } from "grammy";
import { match, P } from "ts-pattern";
import type { JsonValue } from "type-fest";
import { logger } from "../../../logger.js";
import {
  isRenderedMessage,
  type OutboundVoice,
  type RenderedMessage,
} from "../../adapter-module.js";
import { type AttachmentStore, mediaTypeToExt } from "../../attachment-store.js";
import type { Adapter, StreamHandle, StreamingAdapter, StreamOpts } from "../../types.js";
import { stripHtmlTags } from "./render.js";
import { type SettlingStreamHandle, TelegramStreamHandle } from "./stream-handle.js";
import { splitAtCap } from "./stream-state.js";

const TELEGRAM_CHUNK_TARGET_DEFAULT = 4000;

/** The ceiling of the wait after a first 409. */
const CONFLICT_BACKOFF_FIRST_MS = 5_000;
const CONFLICT_BACKOFF_MAX_MS = 5 * 60_000;
/** A run this long resets the 409 streak; twice the cap, so two pollers taking turns never do. */
const HEALTHY_RUN_MS = 10 * 60_000;

/** One `bot.start()`, from the call until its exit is handled. */
interface PollingRun {
  kind: "polling";
  /** Settles once the run's exit has moved the state on. */
  run: Promise<void>;
  /** `performance.now()` at the `bot.start()` call. */
  startedAt: number;
  /** Consecutive 409s before this run. */
  conflicts: number;
}

/** Where polling is (design/transport/telegram.md → Polling Supervision). */
type PollingState =
  | { kind: "idle" }
  | PollingRun
  | { kind: "backoff"; timer: NodeJS.Timeout }
  | { kind: "failed"; reason: "unauthorized" | "rejected" | "ended" }
  | { kind: "stopped"; drained: Promise<void> };

/** How a `bot.start()` ended. */
type PollingExit =
  /** The way `bot.stop()` ends it: resolved, or a setup retry's wait cut short. */
  | { kind: "ended" }
  | { kind: "conflict"; err: GrammyError }
  | { kind: "unauthorized"; err: GrammyError }
  | { kind: "rejected"; err: unknown };

/** What `bot.start()` rejects with (design/transport/telegram.md → Polling Supervision). */
function classifyRejection(err: unknown): PollingExit {
  return match(err)
    .returnType<PollingExit>()
    .with(P.intersection(P.instanceOf(GrammyError), { error_code: 409 }), (e) => ({
      kind: "conflict",
      err: e,
    }))
    .with(P.intersection(P.instanceOf(GrammyError), { error_code: 401 }), (e) => ({
      kind: "unauthorized",
      err: e,
    }))
    .with(P.intersection(P.instanceOf(Error), { message: "Aborted delay" }), () => ({
      kind: "ended",
    }))
    .otherwise(() => ({ kind: "rejected", err }));
}

/**
 * The wait before the restart that follows the `conflicts`-th 409 in a row: a
 * random point in the upper half of a ceiling that doubles from 5 s to 5 min.
 */
function conflictBackoffMs(conflicts: number): number {
  const ceiling = Math.min(
    CONFLICT_BACKOFF_MAX_MS,
    CONFLICT_BACKOFF_FIRST_MS * 2 ** (conflicts - 1),
  );
  return Math.round(ceiling * (0.5 + Math.random() / 2));
}

export class TelegramAdapter implements Adapter, StreamingAdapter {
  #bot: Bot;
  #attachments: AttachmentStore;
  #activeStreams = new Map<string, SettlingStreamHandle>();
  /** Each run's delivered media paths, kept past a failed handle for the one replacing it. */
  #sentMedia = new Map<string, Set<string>>();
  #polling: PollingState = { kind: "idle" };
  /** Highest update id whose middleware has run to completion. */
  #lastHandledUpdateId: number | undefined;

  constructor(bot: Bot, attachments: AttachmentStore) {
    this.#bot = bot;
    this.#attachments = attachments;
    // Registered before `setup` adds any handler, so it wraps them all. A
    // handler that throws still counts: grammY treats its update as done.
    bot.use(async (ctx, next) => {
      try {
        await next();
      } finally {
        this.#lastHandledUpdateId = Math.max(this.#lastHandledUpdateId ?? 0, ctx.update.update_id);
      }
    });
  }

  /**
   * Poll until `stop()`, starting again after each 409 (design/transport/
   * telegram.md → Polling Supervision). `setup()` calls it once, after
   * registering every handler: grammY refuses middleware once polling starts.
   */
  startPolling(): void {
    if (this.#polling.kind !== "idle") {
      throw new Error(
        `telegram: startPolling() while ${this.#polling.kind}; setup() starts it once`,
      );
    }
    this.#poll(0);
  }

  #poll(conflicts: number): void {
    const state: PollingRun = {
      kind: "polling",
      startedAt: performance.now(),
      conflicts,
      run: this.#bot
        .start({ onStart: () => logger.info("telegram polling started") })
        .then((): PollingExit => ({ kind: "ended" }), classifyRejection)
        .then((exit) => this.#settle(state, exit)),
    };
    this.#polling = state;
  }

  /** Move the state on from `run`'s exit, unless `stop()` already has. */
  #settle(run: PollingRun, exit: PollingExit): void {
    if (this.#polling !== run) {
      match(exit)
        .with({ kind: "ended" }, () => undefined)
        .with({ kind: P.union("conflict", "unauthorized", "rejected") }, ({ err }) =>
          logger.warn({ err }, "telegram polling: failed while stopping"),
        )
        .exhaustive();
      return;
    }
    match(exit)
      .with({ kind: "conflict" }, ({ err }) => {
        const healthy = performance.now() - run.startedAt >= HEALTHY_RUN_MS;
        this.#backoff(err.description, (healthy ? 0 : run.conflicts) + 1);
      })
      .with({ kind: "unauthorized" }, ({ err }) => {
        logger.error(
          { description: err.description },
          "telegram polling: the Bot API refused the bot token (401), revoked or invalid; down until the channel's token is replaced and cogmo restarts",
        );
        this.#polling = { kind: "failed", reason: "unauthorized" };
      })
      .with({ kind: "rejected" }, ({ err }) => {
        logger.error({ err }, "telegram polling: failed; down until cogmo restarts");
        this.#polling = { kind: "failed", reason: "rejected" };
      })
      .with({ kind: "ended" }, () => {
        logger.error("telegram polling: ended without stop(); down until cogmo restarts");
        this.#polling = { kind: "failed", reason: "ended" };
      })
      .exhaustive();
  }

  #backoff(description: string, conflicts: number): void {
    const retryInMs = conflictBackoffMs(conflicts);
    logger.error(
      { description, conflicts, retryInMs },
      "telegram polling: conflict (409), another poller or a webhook is using the bot token; starting again after a backoff",
    );
    // `stop()` clears it; unref'd, so a backoff alone never holds the process open.
    const timer = setTimeout(() => {
      if (this.#polling.kind === "backoff" && this.#polling.timer === timer) this.#poll(conflicts);
    }, retryInMs).unref();
    this.#polling = { kind: "backoff", timer };
  }

  async deliver(platformAddress: string, content: RenderedMessage | JsonValue): Promise<void> {
    const chatId = Number(platformAddress);
    if (isRenderedMessage(content)) {
      // A reply past Telegram's cap goes out as several messages. A split can
      // cut through a tag pair, which the parse fallback turns into plain text.
      for (const part of splitAtCap(content.text)) {
        await this.#sendRendered(chatId, part, content.parseMode);
      }
      // Send any attached images as separate photo messages after the text.
      for (const img of content.images ?? []) {
        await this.#bot.api.sendPhoto(
          chatId,
          new InputFile(img.data, `image.${mediaTypeToExt(img.mediaType)}`),
        );
      }
      // Send any attached documents as separate file messages after photos.
      for (const doc of content.documents ?? []) {
        await this.#bot.api.sendDocument(chatId, new InputFile(doc.data, doc.name));
      }
    } else {
      const text = typeof content === "string" ? content : JSON.stringify(content);
      await this.#bot.api.sendMessage(chatId, text);
    }
  }

  /** Send one message, as plain text when Telegram can't parse its markup. */
  async #sendRendered(
    chatId: number,
    text: string,
    parseMode: RenderedMessage["parseMode"],
  ): Promise<void> {
    try {
      await this.#bot.api.sendMessage(chatId, text, {
        ...(parseMode && { parse_mode: parseMode }),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("can't parse entities")) throw err;
      logger.warn("telegram: HTML parse failed, falling back to plain text");
      await this.#bot.api.sendMessage(chatId, stripHtmlTags(text));
    }
  }

  /**
   * Open the run's stream, or hand back the one already open: Inngest
   * re-invokes the turn at every step boundary, and each invocation opens
   * again. A handle leaves the run once it settles, so an open after a
   * failure — the retry of the step it failed — starts a fresh one.
   */
  async openStream(
    platformAddress: string,
    runId: string,
    opts?: StreamOpts,
  ): Promise<StreamHandle> {
    const existing = this.#activeStreams.get(runId);
    if (existing) return existing;

    const handle = new TelegramStreamHandle(
      this.#bot,
      this.#attachments,
      Number(platformAddress),
      runId,
      {
        chunkChars: opts?.chunkChars ?? TELEGRAM_CHUNK_TARGET_DEFAULT,
        allowEdits: opts?.allowEdits ?? true,
      },
      {
        has: (path) => this.#sentMedia.get(runId)?.has(path) ?? false,
        add: (path) => {
          const paths = this.#sentMedia.get(runId) ?? new Set<string>();
          this.#sentMedia.set(runId, paths.add(path));
        },
      },
    );
    this.#activeStreams.set(runId, handle);
    void handle.done.then((outcome) => {
      if (this.#activeStreams.get(runId) === handle) this.#activeStreams.delete(runId);
      // Kept after a failure: the run's retry opens a fresh handle, which must not resend.
      if (outcome.isOk()) this.#sentMedia.delete(runId);
    });
    return handle;
  }

  /**
   * Voice delivery — Telegram's `sendVoice` renders the OGG/Opus audio as a
   * voice-bubble UI. Other formats fall back to `sendAudio` (regular audio
   * file). Called by the delivery router AFTER the streamed text message
   * has already been delivered (Option B in design/voice.md), so a TTS
   * failure can never strand the user.
   */
  async sendVoice(platformAddress: string, audio: OutboundVoice): Promise<void> {
    const chatId = Number(platformAddress);
    const ext = mediaTypeToExt(audio.mediaType);
    const file = new InputFile(audio.audio, `voice.${ext}`);
    if (audio.mediaType === "audio/ogg" || audio.mediaType === "audio/opus") {
      await this.#bot.api.sendVoice(chatId, file);
    } else {
      // Non-Opus → degrade to sendAudio (still playable, just not the
      // voice-bubble UI). Cogmo doesn't bundle ffmpeg to transcode.
      await this.#bot.api.sendAudio(chatId, file);
    }
  }

  /** Idempotent: a later call settles with the first call's drain. */
  stop(): Promise<void> {
    if (this.#polling.kind === "stopped") return this.#polling.drained;
    const from = this.#polling;
    const drained = Promise.withResolvers<void>();
    // First, so a run that exits from here on settles silently and starts nothing.
    this.#polling = { kind: "stopped", drained: drained.promise };
    drained.resolve(this.#drain(from));
    return drained.promise;
  }

  async #drain(from: Exclude<PollingState, { kind: "stopped" }>): Promise<void> {
    await match(from)
      .with({ kind: "polling" }, ({ run }) => this.#stopRun(run))
      .with({ kind: "backoff" }, ({ timer }) => clearTimeout(timer))
      .with({ kind: P.union("idle", "failed") }, () => undefined)
      .exhaustive();
    // `bot.stop()` fixes its offset before the loop finishes the batch, and
    // confirms nothing once polling is down, so the updates handled since
    // would be redelivered on restart. Confirm past them, after grammY's call
    // settles: concurrent `getUpdates` conflict.
    if (this.#lastHandledUpdateId !== undefined) {
      await this.#bot.api
        .getUpdates({ offset: this.#lastHandledUpdateId + 1, limit: 1, timeout: 0 })
        .catch((err: unknown) =>
          logger.warn({ err }, "telegram: confirming the handled updates on stop failed"),
        );
    }
  }

  async #stopRun(run: Promise<void>): Promise<void> {
    // `bot.stop()` aborts the pending long poll, then confirms the offset
    // past the update being handled, with one more `getUpdates`. Call it
    // before awaiting the run, which only ends once that abort lands.
    const confirmed = this.#bot
      .stop()
      .catch((err: unknown) =>
        logger.warn({ err }, "telegram: confirming the update offset on stop failed"),
      );
    await run;
    await confirmed;
  }
}
