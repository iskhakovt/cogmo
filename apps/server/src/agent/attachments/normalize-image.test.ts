import { crc32, deflateSync } from "node:zlib";
import type { Result } from "neverthrow";
import { beforeAll, describe, expect, it } from "vitest";
import { expectDefined } from "../../test/assertions.js";
import { loadSharp, type Sharp } from "./image-runtime.js";
import {
  type DecodeFailure,
  decodeFailure,
  type NormalizedImage,
  normalizeImage,
  screenImage,
} from "./normalize-image.js";

// sharp 0.35.5 implements `withGainMap()` (dist/output.mjs) but its declarations omit it.
declare module "sharp" {
  interface Sharp {
    /** Attach a generated ISO 21496-1 gain map to a JPEG output: an Ultra HDR JPEG. */
    withGainMap(): Sharp;
  }
}

const CAP = 3_750_000;
let sharp: Sharp;

beforeAll(async () => {
  sharp = await loadSharp();
});

/** RGBA with a fully opaque alpha channel. */
function solid(width: number, height: number) {
  return rgba(width, height, 1);
}

function translucent(width: number, height: number) {
  return rgba(width, height, 0.5);
}

function rgba(width: number, height: number, alpha: number) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 200, g: 80, b: 20, alpha } },
  });
}

function noise(width: number, height: number, channels: 3 | 4) {
  return sharp({
    create: {
      width,
      height,
      channels,
      background: { r: 0, g: 0, b: 0, alpha: 0.5 },
      noise: { type: "gaussian", mean: 128, sigma: 60 },
    },
  });
}

function expectOk(result: Result<NormalizedImage, DecodeFailure>): NormalizedImage {
  if (result.isErr()) throw new Error(`expected ok, got err(${result.error})`);
  return result.value;
}

/** An ISO-BMFF `ftyp` box with `brand` as its major brand. */
function ftyp(brand: string): Uint8Array {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from(`ftyp${brand}`, "latin1"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("mif1miaf", "latin1"),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A tiny PNG whose header declares `width` × `height` RGB pixels. */
function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.alloc(0))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("screenImage", () => {
  it("flags HEIC and HEIF by media type", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(screenImage(bytes, "image/heic")).toBe("heic");
    expect(screenImage(bytes, "IMAGE/HEIF; charset=binary")).toBe("heic");
  });

  it.each(["heic", "heix", "mif1"])("flags the %s ftyp brand under any media type", (brand) => {
    expect(screenImage(ftyp(brand), "application/octet-stream")).toBe("heic");
    expect(screenImage(ftyp(brand), "image/jpeg")).toBe("heic");
  });

  it("passes another ftyp brand to the decoder", () => {
    expect(screenImage(ftyp("avif"), "image/avif")).toBeNull();
  });
});

describe("normalizeImage", () => {
  it("applies EXIF orientation 6 and writes no metadata", async () => {
    const input = await solid(400, 200).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const out = expectOk(await normalizeImage(input));
    expect([out.width, out.height]).toEqual([200, 400]);
    const meta = await sharp(out.data).metadata();
    expect([meta.width, meta.height]).toEqual([200, 400]);
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
  });

  it("fits 2000 × 2000 and doesn't enlarge", async () => {
    const big = expectOk(await normalizeImage(await solid(4000, 3000).jpeg().toBuffer()));
    expect([big.width, big.height]).toEqual([2000, 1500]);
    const small = expectOk(await normalizeImage(await solid(300, 200).jpeg().toBuffer()));
    expect([small.width, small.height]).toEqual([300, 200]);
  });

  it("keeps PNG for transparency and gives JPEG for a fully opaque alpha channel", async () => {
    const transparent = expectOk(await normalizeImage(await translucent(64, 64).png().toBuffer()));
    expect(transparent.mediaType).toBe("image/png");
    expect((await sharp(transparent.data).metadata()).format).toBe("png");

    const opaque = expectOk(await normalizeImage(await solid(64, 64).png().toBuffer()));
    expect(opaque.mediaType).toBe("image/jpeg");
    const meta = await sharp(opaque.data).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.hasAlpha).toBe(false);
  });

  it("takes the first frame of an animated GIF", async () => {
    const frames = Buffer.concat([
      Buffer.alloc(10 * 10 * 3, 0xff),
      Buffer.alloc(10 * 10 * 3, 0x80),
      Buffer.alloc(10 * 10 * 3, 0x00),
    ]);
    const gif = await sharp(frames, { raw: { width: 10, height: 30, channels: 3, pageHeight: 10 } })
      .gif()
      .toBuffer();
    expect((await sharp(gif, { pages: -1 }).metadata()).pages).toBe(3);

    const out = expectOk(await normalizeImage(gif));
    expect([out.width, out.height]).toEqual([10, 10]);
    const { channels } = await sharp(out.data).stats();
    expect(expectDefined(channels[0], "red channel").mean).toBeGreaterThan(240);
  });

  it.each([
    ["WebP", (s: ReturnType<typeof solid>) => s.webp()],
    ["CMYK JPEG", (s: ReturnType<typeof solid>) => s.toColourspace("cmyk").jpeg()],
  ])("gives an sRGB JPEG for %s", async (_name, encodeAs) => {
    const out = expectOk(await normalizeImage(await encodeAs(solid(64, 64)).toBuffer()));
    expect(out.mediaType).toBe("image/jpeg");
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.space).toBe("srgb");
    expect(meta.channels).toBe(3);
  });

  it("subsamples chroma for a lossy source only", async () => {
    const fromPng = expectOk(await normalizeImage(await solid(64, 64).png().toBuffer()));
    expect((await sharp(fromPng.data).metadata()).chromaSubsampling).toBe("4:4:4");
    const fromGif = expectOk(await normalizeImage(await solid(64, 64).gif().toBuffer()));
    expect((await sharp(fromGif.data).metadata()).chromaSubsampling).toBe("4:4:4");
    const fromJpeg = expectOk(await normalizeImage(await solid(64, 64).jpeg().toBuffer()));
    expect((await sharp(fromJpeg.data).metadata()).chromaSubsampling).toBe("4:2:0");
  });

  it("steps an opaque image over the cap down under it", async () => {
    const input = await noise(2000, 2000, 3).png().toBuffer();
    const firstPass = await sharp(input)
      .jpeg({ quality: 85, mozjpeg: true, chromaSubsampling: "4:4:4" })
      .toBuffer();
    expect(firstPass.byteLength).toBeGreaterThan(CAP);
    const out = expectOk(await normalizeImage(input));
    expect(out.mediaType).toBe("image/jpeg");
    expect(out.data.byteLength).toBeLessThanOrEqual(CAP);
  }, 30_000);

  it("steps a transparent image over the cap down under it, still PNG", async () => {
    const input = await noise(2000, 2000, 4).png().toBuffer();
    const out = expectOk(await normalizeImage(input));
    expect(out.mediaType).toBe("image/png");
    expect(out.data.byteLength).toBeLessThanOrEqual(CAP);
    expect(out.width).toBeLessThan(2000);
  }, 30_000);

  // The regression test for an unblocked loader.
  it.each([
    ["TIFF", () => solid(32, 32).tiff().toBuffer()],
    ["AVIF", () => solid(32, 32).avif().toBuffer()],
    [
      "SVG",
      async () =>
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32"/></svg>',
        ),
    ],
  ])("refuses %s through the loader allowlist", async (_name, make) => {
    expect((await normalizeImage(await make()))._unsafeUnwrapErr()).toBe("undecodable");
  });

  it("refuses a truncated JPEG and zero bytes", async () => {
    const jpeg = await noise(256, 256, 3).jpeg().toBuffer();
    const truncated = jpeg.subarray(0, Math.floor(jpeg.byteLength / 2));
    expect((await normalizeImage(truncated))._unsafeUnwrapErr()).toBe("undecodable");
    expect((await normalizeImage(new Uint8Array(0)))._unsafeUnwrapErr()).toBe("undecodable");
  });

  it("refuses a 144-megapixel header before decoding", async () => {
    const started = performance.now();
    const result = await normalizeImage(pngHeader(12_000, 12_000));
    expect(result._unsafeUnwrapErr()).toBe("too_large");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("decodes a mislabelled media type by its content", async () => {
    const png = await translucent(64, 64).png().toBuffer();
    expect(screenImage(png, "image/jpeg")).toBeNull();
    expect(expectOk(await normalizeImage(png)).mediaType).toBe("image/png");
  });

  it("decodes an Ultra HDR JPEG as its SDR base image", async () => {
    const ultraHdr = await solid(64, 48).withGainMap().jpeg().toBuffer();
    // Names the ISO 21496-1 gain map it carries: the fixture is Ultra HDR.
    expect(ultraHdr.includes("21496")).toBe(true);
    const out = expectOk(await normalizeImage(ultraHdr));
    expect([out.mediaType, out.width, out.height]).toEqual(["image/jpeg", 64, 48]);
    expect(out.data.includes("21496")).toBe(false);
  });
});

describe("decodeFailure", () => {
  it.each([
    [new Error("Input image exceeds pixel limit"), "too_large"],
    [new Error("timeout: 42% complete"), "timeout"],
    [new Error("Input buffer contains unsupported image format"), "undecodable"],
    ["not an error", "undecodable"],
  ])("classifies %s as %s", (cause, failure) => {
    expect(decodeFailure(cause)).toBe(failure);
  });
});
