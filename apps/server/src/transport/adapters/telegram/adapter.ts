/**
 * The running adapter: outbound delivery, stream handles, voice, polling
 * supervision and its liveness projection, and a shutdown that confirms
 * handled updates.
 */

import { type Bot, InputFile } from "grammy";
import { match, P } from "ts-pattern";
import type { JsonValue } from "type-fest";
import { logger } from "../../../logger.js";
import {
  isRenderedMessage,
  type OutboundVoice,
  type RenderedMessage,
} from "../../adapter-module.js";
import { type AttachmentStore, mediaTypeToExt } from "../../attachment-store.js";
import type {
  Adapter,
  ChannelError,
  ChannelLiveness,
  StreamHandle,
  StreamingAdapter,
  StreamOpts,
} from "../../types.js";
import {
  classifyRejection,
  conflictBackoffMs,
  HEALTHY_RUN_MS,
  type PollingExit,
  type PollingRun,
  type PollingState,
  projectLiveness,
} from "./polling-state.js";
import {
  channelError,
  failureOutcome,
  isUpdateId,
  type ReceiveOutcome,
  replyOutcome,
} from "./receive-outcome.js";
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
  #polling: PollingState = { kind: "idle" };
  /** Highest update id whose middleware has run to completion. */
  #lastHandledUpdateId: number | undefined;
  /** `performance.now()` at construction, then at each valid batch and finished update; spans runs. */
  #progressAt = performance.now();
  /** `performance.now()` when handling the update in hand began. */
  #handlingSince: number | null = null;

  constructor(bot: Bot, attachments: AttachmentStore) {
    this.#bot = bot;
    this.#attachments = attachments;
    // Registered before `setup` adds any handler, so it wraps them all. A
    // handler that throws still counts: grammY treats its update as done.
    bot.use(async (ctx, next) => {
      this.#handlingSince = performance.now();
      try {
        await next();
      } finally {
        this.#handlingSince = null;
        // grammY hands on an update with no `update_id`, which must neither
        // credit progress nor reach the offset `stop()` confirms.
        if (isUpdateId(ctx.update.update_id)) {
          this.#progressAt = performance.now();
          this.#lastHandledUpdateId = Math.max(
            this.#lastHandledUpdateId ?? 0,
            ctx.update.update_id,
          );
        }
      }
    });
    // Sees every `getUpdates` outcome, the ones grammY retries included. It
    // hands `prev`'s result or error on unchanged, and its bookkeeping can't
    // throw: grammY reads a transformer's throw as a failed request.
    bot.api.config.use((prev, method, payload, signal) => {
      if (method !== "getUpdates") return prev(method, payload, signal);
      const at = this.#polling;
      return prev(method, payload, signal).then(
        (reply) => {
          this.#receive(at, replyOutcome(reply));
          return reply;
        },
        (err: unknown) => {
          this.#receive(at, failureOutcome(err));
          throw err;
        },
      );
    });
  }

  /** The receive loop's projection (design/liveness.md → Telegram receive loop → States). */
  liveness(): ChannelLiveness {
    return projectLiveness(
      this.#polling,
      { progressAt: this.#progressAt, handlingSince: this.#handlingSince },
      performance.now(),
    );
  }

  /** Apply a `getUpdates` outcome to the run it was called in, if that run is still current. */
  #receive(at: PollingState, outcome: ReceiveOutcome): void {
    if (at.kind !== "polling" || this.#polling !== at) return;
    match(outcome)
      .with({ kind: "batch" }, () => {
        at.receive = { kind: "receiving" };
        this.#progressAt = performance.now();
      })
      .with({ kind: "supervised" }, () => undefined)
      .with({ kind: "retrying" }, ({ cause, error }) => {
        const since = at.receive.kind === "retrying" ? at.receive.since : performance.now();
        at.receive = { kind: "retrying", since, cause, error };
      })
      .exhaustive();
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
      receive: { kind: "starting" },
      run: this.#bot
        .start({
          // grammY calls it once setup succeeds, even after `bot.stop()`.
          onStart: () => {
            if (this.#polling.kind !== "stopped") logger.info("telegram polling started");
          },
        })
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
        this.#backoff(channelError(err), (healthy ? 0 : run.conflicts) + 1);
      })
      .with({ kind: "unauthorized" }, ({ err }) => {
        const error = channelError(err);
        logger.error(
          { description: error.detail },
          "telegram polling: the Bot API refused the bot token (401), revoked or invalid; down until the channel's token is replaced and cogmo restarts",
        );
        this.#polling = { kind: "failed", reason: "unauthorized", error };
      })
      .with({ kind: "rejected" }, ({ err }) => {
        logger.error({ err }, "telegram polling: failed; down until cogmo restarts");
        this.#polling = {
          kind: "failed",
          reason: "rejected",
          error: channelError(err),
        };
      })
      .with({ kind: "ended" }, () => {
        logger.error("telegram polling: ended without stop(); down until cogmo restarts");
        this.#polling = { kind: "failed", reason: "ended", error: null };
      })
      .exhaustive();
  }

  #backoff(error: ChannelError, conflicts: number): void {
    const retryInMs = conflictBackoffMs(conflicts);
    logger.error(
      { description: error.detail, conflicts, retryInMs },
      "telegram polling: conflict (409), another poller or a webhook is using the bot token; starting again after a backoff",
    );
    // `stop()` clears it; unref'd, so a backoff alone never holds the process open.
    const timer = setTimeout(() => {
      if (this.#polling.kind === "backoff" && this.#polling.timer === timer) this.#poll(conflicts);
    }, retryInMs).unref();
    this.#polling = { kind: "backoff", timer, conflicts, since: performance.now(), error };
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
