/** Inbound text, photos, documents and voice notes, packed as `InboundContent` and dispatched. */

import { isUtf8 } from "node:buffer";
import type { Bot } from "grammy";
import type { Document } from "grammy/types";
import { lookup } from "mime-types";
import { err, ok, type Result } from "neverthrow";
import { match, P } from "ts-pattern";
import { z } from "zod";
import { logger } from "../../../logger.js";
import { type InboundContent, MAX_INBOUND_FILE_BYTES } from "../../content.js";
import type { Transport } from "../../transport.js";
import { toCmdCtx } from "./commands/reply.js";
import { forwardedFrom, inboundTextBlock, othersOrigin } from "./forwarded.js";
import type { DispatchInbound } from "./inbound-dispatch.js";
import type { ProfileDialogs } from "./profile-dialog.js";
import type { RepoDialogs } from "./repo-dialog.js";

/**
 * Why a Telegram-hosted file couldn't be downloaded. The caller skips the
 * message rather than persisting a bogus attachment, telling the user about
 * `too_large` and logging the rest at error:
 *
 *   - `too_large`: over the Bot API's download limit, by its declared size or
 *     by `getFile`'s refusal.
 *   - `no_file_path`: `getFile()` answered without a `file_path`, which the
 *     Bot API marks optional. The URL would end in `/undefined`, and the 404
 *     page behind it would be uploaded as the user's file.
 *   - `local_path`: a Bot API server run with `--local` answers with an
 *     absolute path on its own disk instead of a path under `/file/`.
 *     Reading it needs that disk, which this process doesn't have.
 *   - `http_error`: the file endpoint answers 4xx/5xx (rate limit, expired
 *     file_id, transient outage), and `arrayBuffer()` would hand back the
 *     error body just the same.
 */
type FileDownloadError =
  | { kind: "too_large"; fileId: string }
  | { kind: "no_file_path"; fileId: string }
  | { kind: "local_path"; fileId: string; path: string }
  | { kind: "http_error"; fileId: string; status: number; statusText: string };

/** The Bot API's answer to `getFile` for a file over its download limit. */
const FileTooBigSchema = z.object({
  error_code: z.literal(400),
  description: z.string().includes("file is too big"),
});

const TOO_LARGE_REPLY = `That file is too large to open. Telegram bots can download files up to ${MAX_INBOUND_FILE_BYTES / 2 ** 20} MB.`;

const OCTET_STREAM = "application/octet-stream";

/** How far into a file the binary-byte check reads: git's window for the same test. */
const TEXT_SNIFF_BYTES = 8000;

/**
 * The image formats the vision routes accept (design/transport/attachments.md
 * → Research Base), which a document routes to an image block. A document of
 * any other image format stays a document, which arrival normalizes or turns
 * into a placeholder (design/transport/attachments.md → Images).
 */
const VISION_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/**
 * A document's media type. Telegram's `mime_type` is the sender's claim: it
 * is missing for some uploads and generic `application/octet-stream` for
 * types the sending client didn't recognise (an `.html` file arrives that
 * way). Either way the content decides between text and binary, and the file
 * name's extension names the type within each: UTF-8 text keeps a `text/*`
 * type, or `application/pdf` for an all-ASCII PDF, and is otherwise
 * `text/plain`, since mime-db maps some source files to binary types (`.ts`
 * to `video/mp2t`). With no bytes to read, a file too large to download takes
 * the extension's type.
 */
function documentMediaType(
  doc: Pick<Document, "mime_type" | "file_name">,
  bytes: Uint8Array | undefined,
): string {
  if (doc.mime_type && doc.mime_type !== OCTET_STREAM) return doc.mime_type;
  const byExtension = (doc.file_name && lookup(doc.file_name)) || OCTET_STREAM;
  if (bytes === undefined || !isUtf8Text(bytes)) return byExtension;
  return byExtension.startsWith("text/") || byExtension === "application/pdf"
    ? byExtension
    : "text/plain";
}

/**
 * Whether `bytes` are valid UTF-8, the encoding the LLM adapters decode text
 * documents with, and open with none of the control bytes the WHATWG MIME
 * Sniffing Standard counts as binary data.
 */
function isUtf8Text(bytes: Uint8Array): boolean {
  return isUtf8(bytes) && !bytes.subarray(0, TEXT_SNIFF_BYTES).some(isBinaryDataByte);
}

function isBinaryDataByte(byte: number): boolean {
  return (
    byte <= 0x08 ||
    byte === 0x0b ||
    (byte >= 0x0e && byte <= 0x1a) ||
    (byte >= 0x1c && byte <= 0x1f)
  );
}

interface FileDownloadCtx {
  api: { getFile: (fileId: string) => Promise<{ file_path?: string }> };
}

/** A photo size, document or voice note. */
interface TelegramFile {
  file_id: string;
  file_size?: number;
}

async function getFile(
  ctx: FileDownloadCtx,
  fileId: string,
): Promise<Result<{ file_path?: string }, FileDownloadError>> {
  try {
    return ok(await ctx.api.getFile(fileId));
  } catch (error) {
    if (FileTooBigSchema.safeParse(error).success) return err({ kind: "too_large", fileId });
    throw error;
  }
}

/** Download a Telegram-hosted file (photo / document / voice / etc.). */
async function downloadTelegramFile(
  ctx: FileDownloadCtx,
  { file_id: fileId, file_size: declaredBytes }: TelegramFile,
  { apiRoot, token }: { apiRoot: string; token: string },
): Promise<Result<Buffer, FileDownloadError>> {
  if (declaredBytes !== undefined && declaredBytes > MAX_INBOUND_FILE_BYTES) {
    return err({ kind: "too_large", fileId });
  }
  const file = await getFile(ctx, fileId);
  if (file.isErr()) return err(file.error);
  const path = file.value.file_path;
  if (!path) return err({ kind: "no_file_path", fileId });
  if (path.startsWith("/")) return err({ kind: "local_path", fileId, path });
  const url = `${apiRoot}/file/bot${token}/${path}`;
  const response = await fetch(url);
  if (!response.ok) {
    return err({
      kind: "http_error",
      fileId,
      status: response.status,
      statusText: response.statusText,
    });
  }
  return ok(Buffer.from(await response.arrayBuffer()));
}

/** Tell the user a file is over the download limit, and log the failure as `message`. */
function reportDownloadFailure(
  ctx: { reply: (text: string) => Promise<unknown> },
  error: FileDownloadError,
  message: string,
): Promise<void> {
  return match(error)
    .with({ kind: "too_large" }, async () => {
      logger.info({ error }, message);
      await ctx.reply(TOO_LARGE_REPLY);
    })
    .with({ kind: P.union("no_file_path", "local_path", "http_error") }, async () => {
      logger.error({ error }, message);
    })
    .exhaustive();
}

export interface MessageHandlerDeps {
  transport: Transport;
  /** The bot token, which Telegram's file download URL carries. */
  token: string;
  /** The Bot API server files download from: Telegram's, or a self-hosted one. */
  apiRoot: string;
  profileDialogs: ProfileDialogs;
  repoDialogs: RepoDialogs;
  dispatchInbound: DispatchInbound;
}

export function registerMessageHandlers(
  bot: Bot,
  { transport, token, apiRoot, profileDialogs, repoDialogs, dispatchInbound }: MessageHandlerDeps,
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

      const download = await downloadTelegramFile(ctx, photo, { apiRoot, token });
      if (download.isErr()) {
        await reportDownloadFailure(ctx, download.error, "failed to process photo");
        return;
      }
      const buffer = download.value;

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
      const name = doc.file_name;
      const caption = ctx.message.caption ?? "";
      const origin = othersOrigin(ctx.message.forward_origin, ctx.from.id);

      // Forwarded without a caption, the marked block is empty and names the sender.
      const content: InboundContent = [];
      if (caption || origin !== undefined) content.push(inboundTextBlock(caption, origin));

      if (doc.file_size !== undefined && doc.file_size > MAX_INBOUND_FILE_BYTES) {
        // `getFile` refuses it, so the block names the file and its size and
        // arrival turns it into the too-large placeholder.
        content.push({
          type: "document",
          mediaType: documentMediaType(doc, undefined),
          ...(name && { name }),
          bytes: doc.file_size,
        });
      } else {
        const download = await downloadTelegramFile(ctx, doc, { apiRoot, token });
        if (download.isErr()) {
          await reportDownloadFailure(ctx, download.error, "failed to process document");
          return;
        }
        const buffer = download.value;
        const mediaType = documentMediaType(doc, buffer);
        const path = await transport.uploadAttachment(buffer, mediaType);

        // Telegram's "Send as file" delivers images (PNG, full-res JPEG, etc.)
        // as documents. A vision format goes to the image block, which the
        // vision routes read; Anthropic's `document` block refuses image types.
        content.push({
          type: VISION_MEDIA_TYPES.has(mediaType) ? "image" : "document",
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

      const download = await downloadTelegramFile(ctx, voice, { apiRoot, token });
      if (download.isErr()) {
        await reportDownloadFailure(ctx, download.error, "failed to process voice message");
        return;
      }
      const buffer = download.value;
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
  // (with a duration cap and a separate block type).
}
