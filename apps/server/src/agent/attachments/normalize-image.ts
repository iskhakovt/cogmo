/**
 * Inbound image normalization: untrusted bytes in, a bounded sRGB JPEG or PNG
 * with no metadata out. See design/transport/attachments.md → Images.
 */

import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { Channels } from "sharp";
import { match } from "ts-pattern";
import { loadSharp, type Sharp } from "./image-runtime.js";

/**
 * Why `normalizeImage` refused an image: sharp couldn't read it, it is over
 * the pixel guard, or it outran the timeout, which says as much about the
 * host's load as about the input.
 */
export type DecodeFailure = "undecodable" | "too_large" | "timeout";

export interface NormalizedImage {
  data: Buffer;
  mediaType: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

const MAX_INPUT_PIXELS = 100_000_000;
const TIMEOUT_SECONDS = 10;
const MAX_EDGE = 2000;
/** 5,000,000 bytes of base64: Bedrock's and Google Cloud's per-image limit. */
const MAX_OUTPUT_BYTES = 3_750_000;
const SHRINK_FACTOR = 0.75;

const HEIF_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);
const HEIF_BRANDS: ReadonlySet<string> = new Set(["heic", "heix", "mif1"]);

/**
 * The check that needs no decode, run before any sharp call: HEIC or HEIF by
 * media type or major `ftyp` brand. null: decode it. Arrival has already
 * refused an input over the byte cap.
 */
export function screenImage(bytes: Uint8Array, mediaType: string): "heic" | null {
  return isHeif(bytes, mediaType) ? "heic" : null;
}

/** By the media type's essence, or by the major brand of an ISO-BMFF `ftyp` box. */
function isHeif(bytes: Uint8Array, mediaType: string): boolean {
  const essence = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (HEIF_MEDIA_TYPES.has(essence)) return true;
  if (bytes.byteLength < 12) return false;
  const ascii = (start: number) => Buffer.from(bytes.subarray(start, start + 4)).toString("latin1");
  return ascii(4) === "ftyp" && HEIF_BRANDS.has(ascii(8));
}

/** A decoded, oriented and resized image, 8-bit sRGB. */
interface Raster {
  data: Buffer;
  width: number;
  height: number;
  channels: Channels;
}

type Encoding =
  | { kind: "png"; palette: boolean }
  | { kind: "jpeg"; quality: number; chroma: "4:4:4" | "4:2:0" };

/** Decode, orient, fit 2000×2000, encode, cap at 3,750,000 bytes. sharp refusing the input (unsupported/blocked format, failOn warning, truncated, timeout) → err("undecodable"); over the 100-megapixel guard → err("too_large"). Any other throw propagates. */
export async function normalizeImage(
  bytes: Uint8Array,
): Promise<Result<NormalizedImage, DecodeFailure>> {
  // sharp's constructor throws on an empty buffer rather than rejecting.
  if (bytes.byteLength === 0) return err("undecodable");
  const sharp = await loadSharp();
  const input = () =>
    sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "warning", pages: 1 }).timeout({
      seconds: TIMEOUT_SECONDS,
    });

  const header = await vips(input().metadata());
  if (header.isErr()) return err(header.error);
  const decoded = await vips(
    input()
      .autoOrient()
      .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true }),
  );
  if (decoded.isErr()) return err(decoded.error);
  const { data, info } = decoded.value;
  const raster: Raster = { data, width: info.width, height: info.height, channels: info.channels };

  const transparent = await hasTransparency(sharp, raster);
  if (transparent.isErr()) return err(transparent.error);
  const lossless = header.value.format === "png" || header.value.format === "gif";
  const first: Encoding = transparent.value
    ? { kind: "png", palette: false }
    : { kind: "jpeg", quality: 85, chroma: lossless ? "4:4:4" : "4:2:0" };
  const reduced = match(first)
    .returnType<Encoding>()
    .with({ kind: "png" }, () => ({ kind: "png", palette: true }))
    .with({ kind: "jpeg" }, (jpeg) => ({ ...jpeg, quality: 70 }))
    .exhaustive();
  return capped(sharp, raster, first, reduced);
}

async function hasTransparency(
  sharp: Sharp,
  raster: Raster,
): Promise<Result<boolean, DecodeFailure>> {
  if (raster.channels !== 2 && raster.channels !== 4) return ok(false);
  const stats = await vips(fromRaster(sharp, raster).stats());
  return stats.map((s) => !s.isOpaque);
}

/** Encode at full size; over the cap, re-encode at `reduced`, then shrink the long edge a quarter per step. */
async function capped(
  sharp: Sharp,
  raster: Raster,
  first: Encoding,
  reduced: Encoding,
): Promise<Result<NormalizedImage, DecodeFailure>> {
  const full = await encode(sharp, raster, first, null);
  if (full.isErr() || full.value.data.byteLength <= MAX_OUTPUT_BYTES) return full;
  let longEdge = Math.max(raster.width, raster.height);
  for (;;) {
    const attempt = await encode(sharp, raster, reduced, longEdge);
    if (attempt.isErr() || attempt.value.data.byteLength <= MAX_OUTPUT_BYTES || longEdge === 1) {
      return attempt;
    }
    longEdge = Math.max(1, Math.floor(longEdge * SHRINK_FACTOR));
  }
}

async function encode(
  sharp: Sharp,
  raster: Raster,
  encoding: Encoding,
  longEdge: number | null,
): Promise<Result<NormalizedImage, DecodeFailure>> {
  const sized =
    longEdge === null
      ? fromRaster(sharp, raster)
      : fromRaster(sharp, raster).resize(longEdge, longEdge, { fit: "inside" });
  const { pipeline, mediaType } = match(encoding)
    .with({ kind: "png" }, ({ palette }) => ({
      pipeline: sized.png(
        palette
          ? // Quantizing at the default effort takes 8 s for 2000 × 2000 of noise on one thread.
            { compressionLevel: 9, palette: true, effort: 1 }
          : { compressionLevel: 9 },
      ),
      mediaType: "image/png" as const,
    }))
    .with({ kind: "jpeg" }, ({ quality, chroma }) => ({
      pipeline: sized.removeAlpha().jpeg({ quality, mozjpeg: true, chromaSubsampling: chroma }),
      mediaType: "image/jpeg" as const,
    }))
    .exhaustive();
  const out = await vips(pipeline.toBuffer({ resolveWithObject: true }));
  return out.map(({ data, info }) => ({
    data,
    mediaType,
    width: info.width,
    height: info.height,
  }));
}

function fromRaster(sharp: Sharp, raster: Raster) {
  return sharp(raster.data, {
    raw: { width: raster.width, height: raster.height, channels: raster.channels },
  }).timeout({ seconds: TIMEOUT_SECONDS });
}

/** A libvips failure is a verdict on the input: over the pixel guard, or unreadable. */
function vips<T>(work: Promise<T>): ResultAsync<T, DecodeFailure> {
  return ResultAsync.fromPromise(work, decodeFailure);
}

/** A sharp rejection as the failure it stands for. */
export function decodeFailure(cause: unknown): DecodeFailure {
  const message = cause instanceof Error ? cause.message : "";
  if (message.includes("exceeds pixel limit")) return "too_large";
  // libvips' progress callback kills the pipeline with `timeout: <n>% complete`.
  if (message.startsWith("timeout:")) return "timeout";
  return "undecodable";
}
