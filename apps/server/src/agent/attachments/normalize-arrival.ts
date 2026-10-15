/**
 * Arrival (design/transport/attachments.md): the turn's inbound batch as the
 * content its user row stores. Every attachment becomes a ref to a
 * write-once object or a placeholder naming the file, so the row renders the
 * same bytes on every later request.
 */

import { match } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import type { AttachmentBudget } from "../../llm/attachment-limits.js";
import { isTextLikeDocumentMediaType } from "../../llm/content.js";
import { logger } from "../../logger.js";
import { attachmentPlaceholders } from "../../metrics.js";
import type {
  FinishedOriginal,
  NormalizedImageResult,
} from "../../transport/attachment-original.js";
import type { AttachmentStore } from "../../transport/attachment-store.js";
import {
  type InboundContent,
  MAX_INBOUND_FILE_BYTES,
  renderInboundText,
} from "../../transport/content.js";
import type { TransportStore } from "../../transport/store/index.js";
import { renderUserContent, type SubstitutedInbound } from "../handle-message/inbound-batch.js";
import type { StoredContent, StoredContentBlock } from "../stored-content.js";
import type { normalizeImage, screenImage } from "./normalize-image.js";
import { placeholderText as rendererPlaceholderText } from "./render-stored-content.js";

/** Why arrival stores a placeholder instead of an attachment. */
type ArrivalPlaceholderReason =
  | "heic"
  | "undecodable"
  | "decode_crashed"
  | "timeout"
  | "empty"
  | "too_large"
  | "unreadable_pdf"
  | "unsupported"
  | "url"
  | "turn_cap"
  | "missing"
  | "rejected";

type AttachmentKind = "image" | "document";

/** How a placeholder names each kind: its label, the name of an unnamed file, and its ref. */
const KINDS = {
  image: { label: "Image", unnamed: "photo", ref: "image_ref" },
  document: { label: "Document", unnamed: "document", ref: "document_ref" },
} as const satisfies Record<
  AttachmentKind,
  { label: string; unnamed: string; ref: "image_ref" | "document_ref" }
>;

function arrivalPlaceholderText(
  reason: ArrivalPlaceholderReason,
  kind: AttachmentKind,
  name: string,
): string {
  const label = `${KINDS[kind].label}: ${name}`;
  return match(reason)
    .with("heic", () => `[${label}. HEIC isn't supported; send it as a photo.]`)
    .with(
      "undecodable",
      "decode_crashed",
      () => `[${label}. The image couldn't be read; send it as a photo.]`,
    )
    .with("timeout", () => `[${label}. The image took too long to process; send it again.]`)
    .with("too_large", () => `[${label}. Too large to attach.]`)
    .with("empty", () => `[${label}. The file is empty.]`)
    .with("unreadable_pdf", () => `[${label}. The PDF couldn't be read; send an unlocked PDF.]`)
    .with("unsupported", () => `[${label}. This file type can't be read; send a PDF or text.]`)
    .with("url", () => `[${label}. Linked files aren't fetched.]`)
    .with("turn_cap", () => `[${label}. Not attached; send fewer files at a time.]`)
    .with("missing", () => `[${label}. The file couldn't be stored; send it again.]`)
    .with("rejected", () => rendererPlaceholderText("rejected", KINDS[kind].ref, name))
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
    | "findFinishedAttachmentOriginal"
    | "claimAttachmentDecode"
    | "finishAttachmentDecode"
    | "abandonAttachmentDecode"
  >;
  attachments: Pick<AttachmentStore, "read" | "put">;
  images: { screen: typeof screenImage; normalize: typeof normalizeImage };
}

/** One inbound attachment block, as the batch carries it. */
type InboundAttachment = Extract<
  Exclude<InboundContent, string>[number],
  { type: "image" | "document" }
>;

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
  for (const { id, content } of inbound) {
    if (typeof content === "string") {
      pushText(blocks, content);
      continue;
    }
    for (const [index, block] of content.entries()) {
      if (block.type === "text") {
        pushText(blocks, renderInboundText(block.text, block.forwarded));
      } else if (block.type === "image" || block.type === "document") {
        // An inline original's key: its inbound row and position, durable across retries.
        const inlineStem = `inbound/${id}-${index}`;
        blocks.push(...(await arriveAttachment(deps, route, load, block, inlineStem)));
      }
      // Voice was substituted with its transcript upstream.
    }
  }
  return blocks;
}

/**
 * Append the user's `text`, joined by a newline to the user text before it as
 * a batch without attachments joins its rows. Blank text is dropped: a
 * provider refuses an empty text block, and the row replays on every turn.
 */
function pushText(blocks: StoredContentBlock[], text: string): void {
  if (text.trim() === "") return;
  const last = blocks.at(-1);
  if (last?.type === "text" && last.harness === undefined) {
    blocks[blocks.length - 1] = { type: "text", text: `${last.text}\n${text}` };
  } else {
    blocks.push({ type: "text", text });
  }
}

function placeholder(
  reason: ArrivalPlaceholderReason,
  kind: AttachmentKind,
  attachment: InboundAttachment,
): StoredContentBlock[] {
  const name = attachment.name ?? KINDS[kind].unnamed;
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
  inlineStem: string,
): Promise<StoredContentBlock[]> {
  const kind: AttachmentKind =
    attachment.type === "image" || isImageMediaType(attachment.mediaType) ? "image" : "document";
  if (attachment.source === "url") return placeholder("url", kind, attachment);
  if (attachment.path === undefined && attachment.data === undefined) {
    // A size-only block: a file too large to download.
    return placeholder("too_large", kind, attachment);
  }
  if (kind === "image" && attachment.path !== undefined) {
    // A re-batched original reuses its record without reading the bytes again.
    const { path } = attachment;
    const record = await deps.runInTx((tx) =>
      deps.transportStore.findFinishedAttachmentOriginal(tx, path),
    );
    if (record !== null) {
      return imageBlocks(route, load, attachment, path, recorded(record));
    }
  }

  const original = await readOriginal(deps, attachment, inlineStem);
  if (original === null) return placeholder("missing", kind, attachment);
  if (original.bytes.length > MAX_INBOUND_FILE_BYTES) {
    return placeholder("too_large", kind, attachment);
  }

  return match(kind)
    .with("image", () => arriveImage(deps, route, load, attachment, original))
    .with("document", () => arriveDocument(deps, route, load, attachment, original))
    .exhaustive();
}

async function arriveDocument(
  deps: NormalizeArrivalDeps,
  route: ArrivalRoute,
  load: TurnLoad,
  attachment: InboundAttachment,
  original: { path: string; bytes: Buffer },
): Promise<StoredContentBlock[]> {
  const essence = (attachment.mediaType.split(";")[0] ?? "").trim().toLowerCase();
  if (essence === "application/pdf") return arrivePdf(route, load, attachment, original);
  if (isTextLikeDocumentMediaType(attachment.mediaType)) {
    return arriveText(deps, route, load, attachment, original);
  }
  return placeholder("unsupported", "document", attachment);
}

/** The original's key and bytes; an inline original is stored first, under `inlineStem`. */
async function readOriginal(
  deps: NormalizeArrivalDeps,
  attachment: InboundAttachment,
  inlineStem: string,
): Promise<{ path: string; bytes: Buffer } | null> {
  if (attachment.path !== undefined) {
    const read = await deps.attachments.read(attachment.path);
    return read.isOk() ? { path: attachment.path, bytes: read.value } : null;
  }
  const bytes = Buffer.from(attachment.data ?? "", "base64");
  const path = await deps.attachments.put(inlineStem, bytes, attachment.mediaType);
  return { path, bytes };
}

/**
 * A normalized copy's key stem, derived from its original's so a retried
 * upload overwrites the same object: `inbound/<id>.png` → `normalized/<id><suffix>`.
 */
function normalizedStem(originalPath: string, suffix: string): string {
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
  return imageBlocks(
    route,
    load,
    attachment,
    original.path,
    await normalizedResult(deps, original),
  );
}

/** An image's outcome as row blocks: its label and ref within the turn's cap, else a placeholder. */
function imageBlocks(
  route: ArrivalRoute,
  load: TurnLoad,
  attachment: InboundAttachment,
  originalPath: string,
  result: ImageOutcome,
): StoredContentBlock[] {
  return match(result)
    .with({ kind: "placeholder" }, ({ reason }) => placeholder(reason, "image", attachment))
    .with({ kind: "rejected" }, () => placeholder("rejected", "image", attachment))
    .with({ kind: "timeout" }, () => placeholder("timeout", "image", attachment))
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
          original: { path: originalPath, mediaType: attachment.mediaType },
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
): Promise<ImageOutcome> {
  const { runInTx, transportStore } = deps;
  const claim = await runInTx((tx) => transportStore.claimAttachmentDecode(tx, original.path));
  return match(claim)
    .with({ kind: "existing" }, ({ original: record }) => recorded(record))
    .with({ kind: "claimed" }, ({ attempt }) =>
      attempt > MAX_DECODE_ATTEMPTS
        ? // Every earlier attempt died decoding it.
          finish(deps, original.path, { kind: "placeholder", reason: "decode_crashed" })
        : decode(deps, original),
    )
    .exhaustive();
}

/**
 * Decode under this attempt's `decoding` marker. A decoder that throws
 * leaves the marker, so the next claim counts the attempt as it counts a
 * crash, and a throw that repeats on the same bytes ends at the decode-crash
 * placeholder. A failed upload abandons it, so the retry decodes again; so
 * does a timeout, which records nothing, since it may say more about the
 * host's load than the input.
 */
async function decode(
  deps: NormalizeArrivalDeps,
  original: { path: string; bytes: Buffer },
): Promise<ImageOutcome> {
  const decoded = await deps.images.normalize(original.bytes);
  if (decoded.isErr()) {
    return match(decoded.error)
      .with("timeout", () => abandon(deps, original.path))
      .with("undecodable", "too_large", (reason) =>
        finish(deps, original.path, { kind: "placeholder", reason }),
      )
      .exhaustive();
  }
  const image = decoded.value;
  let path: string;
  try {
    path = await deps.attachments.put(
      normalizedStem(original.path, ""),
      image.data,
      image.mediaType,
    );
  } catch (error) {
    await abandon(deps, original.path);
    throw error;
  }
  return finish(deps, original.path, {
    kind: "image",
    path,
    mediaType: image.mediaType,
    width: image.width,
    height: image.height,
    bytes: image.data.length,
  });
}

/**
 * `decoding` → deleted, leaving the outcome unrecorded: a timeout, unless
 * another attempt finished the record first, whose result every row then
 * shares.
 */
async function abandon(deps: NormalizeArrivalDeps, originalPath: string): Promise<ImageOutcome> {
  const abandoned = await deps.runInTx((tx) =>
    deps.transportStore.abandonAttachmentDecode(tx, originalPath),
  );
  return match(abandoned)
    .with({ kind: "abandoned" }, (): ImageOutcome => ({ kind: "timeout" }))
    .with({ kind: "stale" }, async () => {
      const record = await deps.runInTx((tx) =>
        deps.transportStore.findFinishedAttachmentOriginal(tx, originalPath),
      );
      return record === null ? { kind: "timeout" as const } : recorded(record);
    })
    .exhaustive();
}

/** What arrival makes of an image original: its record's result, a rejection, or a timeout. */
type ImageOutcome = NormalizedImageResult | { kind: "rejected" } | { kind: "timeout" };

/** Decodes a `decoding` record gets before its next claim records the decode-crash placeholder. */
const MAX_DECODE_ATTEMPTS = 2;

/** A finished record's outcome. */
function recorded(original: FinishedOriginal): ImageOutcome {
  return match(original)
    .with({ state: "ready" }, ({ result }) => result)
    .with({ state: "rejected" }, () => ({ kind: "rejected" as const }))
    .exhaustive();
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
): Promise<ImageOutcome> {
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

/** A generous bound on characters per token: English prose averages about four. */
const MAX_CHARS_PER_TOKEN = 8;

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
  // A provider refuses an empty text, at counting and at sending alike.
  if (full.trim() === "") return placeholder("empty", "document", attachment);
  const allowance = route.textDocumentTokens - load.textTokens;
  const fitted = await fitText(full, route.textDocumentBytes, allowance, route.countTokens);
  if (fitted === null) return placeholder("turn_cap", "document", attachment);
  const uncut = fitted.text === full;
  // Uncut, the ref names the original, whose size is what the renderer sends.
  const sent = uncut ? original.bytes : Buffer.from(fitted.text, "utf8");
  if (!admit(route, load, sent.length, false)) {
    return placeholder("turn_cap", "document", attachment);
  }
  load.textTokens += fitted.tokens;

  const name = attachment.name ?? "document.txt";
  if (uncut) {
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
  const path = await deps.attachments.put(
    normalizedStem(original.path, `.${fitted.kept}`),
    sent,
    attachment.mediaType,
  );
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
  // No text holds more characters per token than this, so the first count
  // never carries more than the allowance could keep.
  kept = Math.min(kept, Math.max(0, allowance) * MAX_CHARS_PER_TOKEN);
  if (kept > 0 && kept < total && isHighSurrogate(text.charCodeAt(kept - 1))) kept -= 1;
  for (let attempt = 0; attempt < MAX_TEXT_FITS; attempt++) {
    const candidate = kept === total ? text : elided(text, kept);
    const tokens = await countTokens(candidate);
    if (tokens <= allowance) return { text: candidate, tokens, kept };
    if (kept === 0) return null;
    // Proportional, with a margin so one recount usually suffices.
    kept = Math.floor((kept * Math.max(0, allowance)) / tokens / 1.05);
    // Never end on the high half of a surrogate pair.
    if (kept > 0 && isHighSurrogate(text.charCodeAt(kept - 1))) kept -= 1;
  }
  return null;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
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
