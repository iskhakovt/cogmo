/** Inbound text, photos, documents and voice notes, packed as `InboundContent` and dispatched. */

import type { Bot } from "grammy";
import { logger } from "../../../logger.js";
import type { InboundContent } from "../../content.js";
import type { Transport } from "../../transport.js";
import { toCmdCtx } from "./commands/reply.js";
import { forwardedFrom, inboundTextBlock, othersOrigin } from "./forwarded.js";
import type { DispatchInbound } from "./inbound-dispatch.js";
import type { ProfileDialogs } from "./profile-dialog.js";
import type { RepoDialogs } from "./repo-dialog.js";

/**
 * Download a Telegram-hosted file (photo / document / voice / etc.) by file_id.
 *
 * Two failure modes the inline `getFile + fetch + arrayBuffer` chain
 * silently absorbed:
 *
 *   1. `getFile()` returns `file_path: undefined` for files >20MB and for
 *      certain media types. The URL would become `.../bot<token>/undefined`
 *      and Telegram's CDN responds with a 404 HTML page; without an
 *      explicit guard we'd upload that HTML as the user's "document".
 *   2. The CDN can return 4xx/5xx (rate limit, expired file_id, transient
 *      outage). `arrayBuffer()` succeeds anyway, returning the error body —
 *      same garbage-upload outcome.
 *
 * Throws on either, so the caller's existing try/catch logs and skips
 * instead of persisting a bogus attachment.
 */
interface FileDownloadCtx {
  api: { getFile: (fileId: string) => Promise<{ file_path?: string }> };
}

async function downloadTelegramFile(
  ctx: FileDownloadCtx,
  fileId: string,
  botToken: string,
): Promise<Buffer> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error(`telegram getFile returned no file_path (file_id=${fileId})`);
  }
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `telegram file download failed: ${response.status} ${response.statusText} (file_id=${fileId})`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

export interface MessageHandlerDeps {
  transport: Transport;
  /** The bot token, which Telegram's file download URL carries. */
  token: string;
  profileDialogs: ProfileDialogs;
  repoDialogs: RepoDialogs;
  dispatchInbound: DispatchInbound;
}

export function registerMessageHandlers(
  bot: Bot,
  { transport, token, profileDialogs, repoDialogs, dispatchInbound }: MessageHandlerDeps,
): void {
  bot.on("message:text", async (ctx) => {
    // Mid-dialog input (e.g. /profile new flow) goes to the FSM, not the agent.
    // This check MUST run before typing indicator / session resolve / emit —
    // otherwise the draft text leaks into conversation history.
    if (profileDialogs.has(ctx.chat.id)) {
      await profileDialogs.handleMessage(transport, toCmdCtx(ctx, ctx.message.text));
      return;
    }
    if (repoDialogs.has(ctx.chat.id)) {
      await repoDialogs.handleMessage(transport, toCmdCtx(ctx, ctx.message.text));
      return;
    }

    await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

    const addr = String(ctx.chat.id);
    const handle = String(ctx.from.id);
    const platformTs = new Date(ctx.message.date * 1000);
    // Forwarded text is packed as a marked block; the user's own stays a bare string.
    const origin = othersOrigin(ctx.message.forward_origin, ctx.from.id);
    const content: InboundContent =
      origin === undefined ? ctx.message.text : [inboundTextBlock(ctx.message.text, origin)];

    await dispatchInbound(ctx, addr, handle, content, platformTs);
  });

  bot.on("message:photo", async (ctx) => {
    await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

    const addr = String(ctx.chat.id);
    const handle = String(ctx.from.id);
    const platformTs = new Date(ctx.message.date * 1000);

    try {
      // Get the largest photo (last in array)
      const photo = ctx.message.photo.at(-1);
      if (!photo) return;

      const buffer = await downloadTelegramFile(ctx, photo.file_id, token);

      const path = await transport.uploadAttachment(buffer, "image/jpeg");
      const caption = ctx.message.caption ?? "";
      const origin = othersOrigin(ctx.message.forward_origin, ctx.from.id);

      // Forwarded without a caption, the marked block is empty and names the sender.
      const content: InboundContent = [];
      if (caption || origin !== undefined) content.push(inboundTextBlock(caption, origin));
      content.push({ type: "image", path, mediaType: "image/jpeg" });

      await dispatchInbound(ctx, addr, handle, content, platformTs);
    } catch (err) {
      logger.error({ err }, "failed to process photo");
    }
  });

  bot.on("message:document", async (ctx) => {
    await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

    const addr = String(ctx.chat.id);
    const handle = String(ctx.from.id);
    const platformTs = new Date(ctx.message.date * 1000);

    try {
      const doc = ctx.message.document;
      // Telegram's mime_type is best-effort — fall back to octet-stream so
      // the LLM call doesn't reject a missing media_type at validation.
      const mediaType = doc.mime_type ?? "application/octet-stream";

      const buffer = await downloadTelegramFile(ctx, doc.file_id, token);

      const path = await transport.uploadAttachment(buffer, mediaType);
      const caption = ctx.message.caption ?? "";
      const name = doc.file_name;

      // Telegram's "Send as file" path delivers images (PNG, full-res JPEG,
      // etc.) as documents. Route image/* MIME types to the image block so
      // they hit the LLM's vision pipeline instead of the document pipeline
      // — Anthropic's `document` content block doesn't accept image media
      // types and would 400-fail.
      const isImage = mediaType.startsWith("image/");
      const origin = othersOrigin(ctx.message.forward_origin, ctx.from.id);

      // Forwarded without a caption, the marked block is empty and names the sender.
      const content: InboundContent = [];
      if (caption || origin !== undefined) content.push(inboundTextBlock(caption, origin));
      if (isImage) {
        content.push({ type: "image", path, mediaType });
      } else {
        content.push({
          type: "document",
          path,
          mediaType,
          ...(name && { name }),
        });
      }

      await dispatchInbound(ctx, addr, handle, content, platformTs);
    } catch (err) {
      logger.error({ err }, "failed to process document");
    }
  });

  // Voice messages — Telegram's first-class voice clip type. Always OGG/Opus.
  // The handler stops at upload + emit; transcription happens in the
  // orchestrator's durable `transcribe-voice` step (so retries replay from
  // cache rather than re-charging STT). See design/voice.md.
  bot.on("message:voice", async (ctx) => {
    await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

    const addr = String(ctx.chat.id);
    const handle = String(ctx.from.id);
    const platformTs = new Date(ctx.message.date * 1000);

    try {
      const voice = ctx.message.voice;
      // Telegram voice clips are always OGG/Opus per the Bot API spec; the
      // mime_type field is informational. Hardcode rather than relying on it.
      const mediaType = "audio/ogg";

      const buffer = await downloadTelegramFile(ctx, voice.file_id, token);
      const path = await transport.uploadAttachment(buffer, mediaType);
      const caption = ctx.message.caption ?? "";
      const durationMs = voice.duration ? voice.duration * 1000 : undefined;
      const origin = othersOrigin(ctx.message.forward_origin, ctx.from.id);

      // A forwarded clip is marked on its own block, so its transcript names
      // the sender whether or not there is a caption.
      const content: InboundContent = [];
      if (caption) content.push(inboundTextBlock(caption, origin));
      content.push({
        type: "voice",
        path,
        mediaType,
        ...(durationMs !== undefined && { durationMs }),
        ...(origin !== undefined && { forwarded: forwardedFrom(origin) }),
      });

      await dispatchInbound(ctx, addr, handle, content, platformTs);
    } catch (err) {
      logger.error({ err }, "failed to process voice message");
    }
  });

  // Note: `message:audio` (music/podcast attachments) is intentionally NOT
  // handled. Routing music files through STT would burn tokens on songs
  // and would also flip auto voice mode to "voice out" because
  // `lastInboundWasVoice` would become true. Voice notes
  // (`message:voice`) are the well-defined PTT shape; explicit
  // transcription of attached audio files is a future opt-in feature
  // (with a duration cap and a separate block type). See PR #149 review.
}
