/**
 * Arrival (design/transport/attachments.md): the turn's inbound batch as the
 * content its user row stores. Every attachment becomes a ref to a
 * write-once object or a placeholder naming the file, so the row renders the
 * same bytes on every later request.
 */

import { createHash } from "node:crypto";
import { match } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import type { AttachmentBudget } from "../../llm/attachment-limits.js";
import { isTextLikeDocumentMediaType } from "../../llm/content.js";
import { logger } from "../../logger.js";
import { attachmentPlaceholders } from "../../metrics.js";
import type {
  AttachmentOriginal,
  NormalizedImageResult,
} from "../../transport/attachment-original.js";
import { type AttachmentStore, mediaTypeToExt } from "../../transport/attachment-store.js";
import { renderInboundText } from "../../transport/content.js";
import type { TransportStore } from "../../transport/store/index.js";
import { renderUserContent, type SubstitutedInbound } from "../handle-message/inbound-batch.js";
import type { StoredContent, StoredContentBlock } from "../stored-content.js";
import { MAX_IMAGE_INPUT_BYTES, type normalizeImage, type screenImage } from "./normalize-image.js";
import { placeholderText as rendererPlaceholderText } from "./render-stored-content.js";

/** Why arrival stores a placeholder instead of an attachment. */
type ArrivalPlaceholderReason =
  | "heic"
  | "undecodable"
  | "decode_crashed"
  | "too_large"
  | "unreadable_pdf"
  | "unsupported"
  | "url"
  | "turn_cap"
  | "missing"
  | "rejected";

type AttachmentKind = "image" | "document";

function arrivalPlaceholderText(
  reason: ArrivalPlaceholderReason,
  kind: AttachmentKind,
  name: string,
): string {
  const label = `${kind === "image" ? "Image" : "Document"}: ${name}`;
  return match(reason)
    .with("heic", () => `[${label}. HEIC isn't supported; send it as a photo.]`)
    .with(
      "undecodable",
      "decode_crashed",
      () => `[${label}. The image couldn't be read; send it as a photo.]`,
    )
    .with("too_large", () => `[${label}. Too large to attach.]`)
    .with("unreadable_pdf", () => `[${label}. The PDF couldn't be read; send an unlocked PDF.]`)
    .with("unsupported", () => `[${label}. This file type can't be read; send a PDF or text.]`)
    .with("url", () => `[${label}. Linked files aren't fetched.]`)
    .with("turn_cap", () => `[${label}. Not attached; send fewer files at a time.]`)
    .with("missing", () => `[${label}. The file couldn't be stored; send it again.]`)
    .with("rejected", () =>
      rendererPlaceholderText("rejected", kind === "image" ? "image_ref" : "document_ref", name),
    )
    .exhaustive();
}

/** The route the turn's attachments are capped to, resolved inside the step. */
export interface ArrivalRoute {
  /** What the turn's attachments may weigh as base64, and how many images. */
  budget: AttachmentBudget;
  /** The adapter's cap on one text document, in UTF-8 bytes; absent when it has none. */
  textDocumentBytes: number | undefined;
  /** What the turn's text documents together may cost: a quarter of the input budget. */
  textDocumentTokens: number;
  countTokens(text: string): Promise<number>;
}

export interface NormalizeArrivalDeps {
  runInTx: Transactor;
  transportStore: Pick<
    TransportStore,
    "claimAttachmentDecode" | "finishAttachmentDecode" | "abandonAttachmentDecode"
  >;
  attachments: Pick<AttachmentStore, "read" | "put">;
  images: { screen: typeof screenImage; normalize: typeof normalizeImage };
}

/** One inbound attachment block, as the batch carries it. */
interface InboundAttachment {
  type: "image" | "document";
  path?: string | undefined;
  data?: string | undefined;
  source?: "base64" | "url" | undefined;
  mediaType: string;
  name?: string | undefined;
  bytes?: number | undefined;
}

/** The turn's running totals against its route. */
interface TurnLoad {
  bytes: number;
  images: number;
  textTokens: number;
  /** Images stored so far, which number their labels. */
  labels: number;
}

/**
 * The user row's content for `inbound`. A batch without attachments is the
 * joined text it has always been; one with attachments is blocks: each text
 * as it was rendered, each image as its label and ref, each document as its
 * ref, and anything that can't be sent as a placeholder.
 *
 * Runs inside `create-user-message`: it uploads, decodes and writes
 * `attachment_originals`, none of which may repeat at a step boundary.
 */
export async function normalizeArrival(
  deps: NormalizeArrivalDeps,
  resolveRoute: () => Promise<ArrivalRoute>,
  inbound: ReadonlyArray<SubstitutedInbound>,
): Promise<StoredContent> {
  const hasAttachments = inbound.some(
    ({ content }) =>
      typeof content !== "string" &&
      content.some((b) => b.type === "image" || b.type === "document"),
  );
  if (!hasAttachments) return renderUserContent(inbound);

  const route = await resolveRoute();
  const load: TurnLoad = { bytes: 0, images: 0, textTokens: 0, labels: 0 };
  const blocks: StoredContentBlock[] = [];
  // Sequential: one image decodes at a time, and the cap admits in order.
  for (const { content } of inbound) {
    if (typeof content === "string") {
      blocks.push({ type: "text", text: content });
      continue;
    }
    for (const block of content) {
      if (block.type === "text") {
        blocks.push({ type: "text", text: renderInboundText(block.text, block.forwarded) });
      } else if (block.type === "image" || block.type === "document") {
        blocks.push(...(await arriveAttachment(deps, route, load, block)));
      }
      // Voice was substituted with its transcript upstream.
    }
  }
  return blocks;
}

function placeholder(
  reason: ArrivalPlaceholderReason,
  kind: AttachmentKind,
  attachment: InboundAttachment,
): StoredContentBlock[] {
  const name = attachment.name ?? (kind === "image" ? "photo" : "document");
  attachmentPlaceholders.add(1, { reason });
  logger.info({ reason, mediaType: attachment.mediaType }, "attachment stored as a placeholder");
  return [
    {
      type: "text",
      text: arrivalPlaceholderText(reason, kind, name),
      harness: "attachment_placeholder",
    },
  ];
}

/** Whether `mediaType` takes the image steps: any `image/*`, HEIC and other non-vision types included. */
function isImageMediaType(mediaType: string): boolean {
  return mediaType.trim().toLowerCase().startsWith("image/");
}

async function arriveAttachment(
  deps: NormalizeArrivalDeps,
  route: ArrivalRoute,
  load: TurnLoad,
  attachment: InboundAttachment,
): Promise<StoredContentBlock[]> {
  const kind: AttachmentKind =
    attachment.type === "image" || isImageMediaType(attachment.mediaType) ? "image" : "document";
  if (attachment.source === "url") return placeholder("url", kind, attachment);
  if (attachment.path === undefined && attachment.data === undefined) {
    // A size-only block: a file too large to download.
    return placeholder("too_large", kind, attachment);
  }

  const original = await readOriginal(deps, attachment);
  if (original === null) return placeholder("missing", kind, attachment);
  if (original.bytes.length > MAX_IMAGE_INPUT_BYTES) {
    return placeholder("too_large", kind, attachment);
  }

  if (kind === "image") return arriveImage(deps, route, load, attachment, original);
  const essence = (attachment.mediaType.split(";")[0] ?? "").trim().toLowerCase();
  if (essence === "application/pdf") return arrivePdf(route, load, attachment, original);
  if (isTextLikeDocumentMediaType(attachment.mediaType)) {
    return arriveText(deps, route, load, attachment, original);
  }
  return placeholder("unsupported", kind, attachment);
}

/** The original's key and bytes; an inline original is stored first, keyed by its digest. */
async function readOriginal(
  deps: NormalizeArrivalDeps,
  attachment: InboundAttachment,
): Promise<{ path: string; bytes: Buffer } | null> {
  if (attachment.path !== undefined) {
    const read = await deps.attachments.read(attachment.path);
    return read.isOk() ? { path: attachment.path, bytes: read.value } : null;
  }
  const bytes = Buffer.from(attachment.data ?? "", "base64");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const path = `inbound/${digest}.${mediaTypeToExt(attachment.mediaType)}`;
  await deps.attachments.put(path, bytes, attachment.mediaType);
  return { path, bytes };
}

/**
 * A normalized copy's key, derived from its original's so a retried upload
 * overwrites the same object: `inbound/<id>.png` → `normalized/<id><suffix>`.
 */
function normalizedKey(originalPath: string, suffix: string): string {
  const slash = originalPath.indexOf("/");
  const rest = slash === -1 ? originalPath : originalPath.slice(slash + 1);
  const dot = rest.lastIndexOf(".");
  const stem = dot > rest.lastIndexOf("/") ? rest.slice(0, dot) : rest;
  return `normalized/${stem}${suffix}`;
}

/** Whether one more attachment of `bytes` (and an image, when `image`) fits the turn's budget; counts it if so. */
function admit(route: ArrivalRoute, load: TurnLoad, bytes: number, image: boolean): boolean {
  const base64 = 4 * Math.ceil(bytes / 3);
  if (load.bytes + base64 > route.budget.bytes) return false;
  if (image && load.images + 1 > route.budget.images) return false;
  load.bytes += base64;
  if (image) load.images += 1;
  return true;
}

async function arriveImage(
  deps: NormalizeArrivalDeps,
  route: ArrivalRoute,
  load: TurnLoad,
  attachment: InboundAttachment,
  original: { path: string; bytes: Buffer },
): Promise<StoredContentBlock[]> {
  const screened = deps.images.screen(original.bytes, attachment.mediaType);
  if (screened !== null) return placeholder(screened, "image", attachment);

  const result = await normalizedResult(deps, original);
  return match(result)
    .with({ kind: "placeholder" }, ({ reason }) => placeholder(reason, "image", attachment))
    .with({ kind: "rejected" }, () => placeholder("rejected", "image", attachment))
    .with({ kind: "image" }, (image): StoredContentBlock[] => {
      if (!admit(route, load, image.bytes, true)) {
        return placeholder("turn_cap", "image", attachment);
      }
      load.labels += 1;
      const named = attachment.name === undefined ? "" : ` (${attachment.name})`;
      return [
        {
          type: "text",
          text: `Image ${load.labels}: ${image.path}${named}`,
          harness: "image_label",
        },
        {
          type: "image_ref",
          path: image.path,
          mediaType: image.mediaType,
          width: image.width,
          height: image.height,
          bytes: image.bytes,
          ...(attachment.name !== undefined && { name: attachment.name }),
          original: { path: original.path, mediaType: attachment.mediaType },
        },
      ];
    })
    .exhaustive();
}

/**
 * The original's normalized result: the record's when one is `ready`,
 * otherwise decoded under a `decoding` marker (design/transport/attachments.md
 * → Original records).
 */
async function normalizedResult(
  deps: NormalizeArrivalDeps,
  original: { path: string; bytes: Buffer },
): Promise<NormalizedImageResult | { kind: "rejected" }> {
  const { runInTx, transportStore } = deps;
  const claim = await runInTx((tx) => transportStore.claimAttachmentDecode(tx, original.path));
  if (claim.kind === "existing") return recorded(claim.original);
  if (claim.attempt > MAX_DECODE_ATTEMPTS) {
    // Every earlier attempt died decoding it.
    return finish(deps, original.path, { kind: "placeholder", reason: "decode_crashed" });
  }

  let result: NormalizedImageResult;
  try {
    const decoded = await deps.images.normalize(original.bytes);
    if (decoded.isErr()) {
      result = { kind: "placeholder", reason: decoded.error };
    } else {
      const image = decoded.value;
      const path = normalizedKey(original.path, `.${mediaTypeToExt(image.mediaType)}`);
      await deps.attachments.put(path, image.data, image.mediaType);
      result = {
        kind: "image",
        path,
        mediaType: image.mediaType,
        width: image.width,
        height: image.height,
        bytes: image.data.length,
      };
    }
  } catch (error) {
    await runInTx((tx) => transportStore.abandonAttachmentDecode(tx, original.path));
    throw error;
  }
  return finish(deps, original.path, result);
}

/** Decodes a `decoding` record gets before its next claim records the decode-crash placeholder. */
const MAX_DECODE_ATTEMPTS = 2;

/** A finished record's outcome. */
function recorded(original: AttachmentOriginal): NormalizedImageResult | { kind: "rejected" } {
  if (original.state === "rejected") return { kind: "rejected" };
  if (original.result === null) {
    throw new Error(
      `attachment original ${original.originalPath} is ${original.state} without a result`,
    );
  }
  return original.result;
}

/**
 * `decoding` → `ready` with `result`. A record another attempt finished
 * first wins, so every row naming the original agrees; with none left
 * (another attempt abandoned it), `result` goes unrecorded.
 */
async function finish(
  deps: NormalizeArrivalDeps,
  originalPath: string,
  result: NormalizedImageResult,
): Promise<NormalizedImageResult | { kind: "rejected" }> {
  const finished = await deps.runInTx((tx) =>
    deps.transportStore.finishAttachmentDecode(tx, originalPath, result),
  );
  return match(finished)
    .with({ kind: "finished" }, { kind: "absent" }, () => result)
    .with({ kind: "stale" }, ({ original }) => recorded(original))
    .exhaustive();
}

async function arrivePdf(
  route: ArrivalRoute,
  load: TurnLoad,
  attachment: InboundAttachment,
  original: { path: string; bytes: Buffer },
): Promise<StoredContentBlock[]> {
  const { bytes } = original;
  const readable =
    bytes.subarray(0, 5).toString("latin1") === "%PDF-" && !bytes.includes("/Encrypt", 0, "latin1");
  if (!readable) return placeholder("unreadable_pdf", "document", attachment);
  if (!admit(route, load, bytes.length, false)) {
    return placeholder("turn_cap", "document", attachment);
  }
  return [
    {
      type: "document_ref",
      path: original.path,
      mediaType: "application/pdf",
      name: attachment.name ?? "document.pdf",
      bytes: bytes.length,
    },
  ];
}

/** Room the elision marker takes within a byte cap. */
const MARKER_RESERVE_BYTES = 100;

/** Bounds how many times a text is re-cut to fit its token allowance. */
const MAX_TEXT_FITS = 8;

async function arriveText(
  deps: NormalizeArrivalDeps,
  route: ArrivalRoute,
  load: TurnLoad,
  attachment: InboundAttachment,
  original: { path: string; bytes: Buffer },
): Promise<StoredContentBlock[]> {
  const full = original.bytes.toString("utf8");
  const allowance = route.textDocumentTokens - load.textTokens;
  const fitted = await fitText(full, route.textDocumentBytes, allowance, route.countTokens);
  if (fitted === null) return placeholder("turn_cap", "document", attachment);
  const sent = Buffer.from(fitted.text, "utf8");
  if (!admit(route, load, sent.length, false)) {
    return placeholder("turn_cap", "document", attachment);
  }
  load.textTokens += fitted.tokens;

  const name = attachment.name ?? "document.txt";
  if (fitted.text === full) {
    return [
      {
        type: "document_ref",
        path: original.path,
        mediaType: attachment.mediaType,
        name,
        bytes: sent.length,
      },
    ];
  }
  // Keyed by what it keeps, so a different cut on another route is another object.
  const path = normalizedKey(original.path, `.${fitted.kept}.txt`);
  await deps.attachments.put(path, sent, attachment.mediaType);
  return [
    {
      type: "document_ref",
      path,
      mediaType: attachment.mediaType,
      name,
      bytes: sent.length,
      original: { path: original.path, mediaType: attachment.mediaType },
    },
  ];
}

/**
 * `text` cut to at most `maxBytes` of UTF-8 and `allowance` tokens, with an
 * elision marker when cut; null when not even the marker fits.
 */
async function fitText(
  text: string,
  maxBytes: number | undefined,
  allowance: number,
  countTokens: (text: string) => Promise<number>,
): Promise<{ text: string; tokens: number; kept: number } | null> {
  const total = text.length;
  let kept = maxBytes === undefined ? total : prefixWithinBytes(text, maxBytes);
  // A cut text carries the marker too, and stays within the cap with it.
  if (maxBytes !== undefined && kept < total) {
    kept = prefixWithinBytes(text, maxBytes - MARKER_RESERVE_BYTES);
  }
  for (let attempt = 0; attempt < MAX_TEXT_FITS; attempt++) {
    const candidate = kept === total ? text : elided(text, kept);
    const tokens = await countTokens(candidate);
    if (tokens <= allowance) return { text: candidate, tokens, kept };
    if (kept === 0) return null;
    // Proportional, with a margin so one recount usually suffices.
    kept = Math.floor((kept * Math.max(0, allowance)) / tokens / 1.05);
  }
  return null;
}

function elided(text: string, kept: number): string {
  return `${text.slice(0, kept)}\n\n[Truncated: the first ${kept} of ${text.length} characters.]`;
}

/** How many leading characters of `text` fit in `maxBytes` of UTF-8, never splitting a surrogate pair. */
function prefixWithinBytes(text: string, maxBytes: number): number {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text.length;
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i) ?? 0;
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + width > maxBytes) break;
    bytes += width;
    i += code >= 0x10000 ? 2 : 1;
  }
  return i;
}
