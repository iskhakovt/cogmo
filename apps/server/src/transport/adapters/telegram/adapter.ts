/** The running adapter: outbound delivery, stream handles, voice, and a shutdown that confirms handled updates. */

import { type Bot, InputFile } from "grammy";
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

export class TelegramAdapter implements Adapter, StreamingAdapter {
  #bot: Bot;
  #attachments: AttachmentStore;
  #activeStreams = new Map<string, SettlingStreamHandle>();
  /** Each run's delivered media paths, kept past a failed handle for the one replacing it. */
  #sentMedia = new Map<string, Set<string>>();
  #polling: Promise<void> | undefined;
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
   * Take ownership of the polling promise returned by grammY's `bot.start()`.
   * Captured so `stop()` can await it to drain — without this, `bot.stop()`
   * aborts a pending retry sleep and grammY rejects with "Aborted delay" as
   * an unhandled rejection, which crashes the test process even though all
   * tests passed.
   */
  attachPolling(polling: Promise<void>): void {
    this.#polling = polling.catch((err: unknown) => {
      // Expected: bot.stop() aborts grammY's retry-backoff sleep, which
      // rejects with "Aborted delay" (from node:timers/promises). Anything
      // else is a real failure worth logging.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== "Aborted delay") {
        logger.error({ err }, "telegram polling loop failed");
      }
    });
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

  async stop(): Promise<void> {
    // `bot.stop()` aborts the pending long poll, then confirms the offset
    // past the update being handled, with one more `getUpdates`. Call it
    // before awaiting the polling loop, which only ends once that abort lands.
    const confirmed = this.#bot
      .stop()
      .catch((err: unknown) =>
        logger.warn({ err }, "telegram: confirming the update offset on stop failed"),
      );
    // Drain the polling loop so any in-flight retry-backoff abort rejects
    // before this process exits — otherwise the unhandled rejection lands
    // on the runtime/test harness instead of being swallowed in attachPolling.
    if (this.#polling) await this.#polling;
    await confirmed;
    // grammY fixed that offset before the loop finished the batch, so the
    // updates handled since would be redelivered on restart. Confirm past
    // them, after grammY's call settles: concurrent `getUpdates` conflict.
    if (this.#lastHandledUpdateId !== undefined) {
      await this.#bot.api
        .getUpdates({ offset: this.#lastHandledUpdateId + 1, limit: 1, timeout: 0 })
        .catch((err: unknown) =>
          logger.warn({ err }, "telegram: confirming the handled updates on stop failed"),
        );
    }
  }
}
