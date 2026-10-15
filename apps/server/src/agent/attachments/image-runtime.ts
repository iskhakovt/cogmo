/**
 * The one way to reach sharp. libvips decodes untrusted bytes in this process,
 * so every loader is blocked except the JPEG, PNG, WebP and GIF buffer
 * loaders; libvips settings are process-wide, so they are applied once, on
 * first load. An Ultra HDR JPEG decodes through the JPEG loader, as its SDR
 * base image, so the Ultra HDR loader stays blocked. See
 * design/transport/attachments.md → Security.
 */

import type { Result } from "neverthrow";
import type sharpModule from "sharp";
import type { DecodeFailure, NormalizedImage } from "./normalize-image.js";

export type Sharp = typeof sharpModule;

/** libvips operations `normalizeImage` may decode with. */
const ALLOWED_IMAGE_LOADERS: ReadonlyArray<string> = [
  "VipsForeignLoadJpegBuffer",
  "VipsForeignLoadPngBuffer",
  "VipsForeignLoadWebpBuffer",
  "VipsForeignLoadNsgifBuffer",
];

let loaded: Promise<Sharp> | undefined;

/**
 * Load sharp and configure libvips: the loader allowlist, no operation cache
 * (every input is unique) and one thread per image, which with
 * `MALLOC_ARENA_MAX=2` bounds allocator fragmentation.
 */
export function loadSharp(): Promise<Sharp> {
  loaded ??= import("sharp").then(({ default: sharp }) => {
    sharp.block({ operation: ["VipsForeignLoad"] });
    sharp.unblock({ operation: [...ALLOWED_IMAGE_LOADERS] });
    sharp.cache(false);
    sharp.concurrency(1);
    return sharp;
  });
  return loaded;
}

/** A 1 × 1 JPEG. */
const PROBE_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

/**
 * Boot check: sharp loads, the allowlist applies, and a 1 × 1 JPEG normalizes.
 * `normalize` is `normalizeImage`, passed in to keep the two modules acyclic.
 */
export async function checkImageRuntime(
  normalize: (bytes: Uint8Array) => Promise<Result<NormalizedImage, DecodeFailure>>,
): Promise<void> {
  try {
    await loadSharp();
  } catch (err) {
    throw new Error(
      "sharp failed to load, so inbound images can't be normalized. The image must carry " +
        "sharp's platform packages (@img/sharp-<platform> and @img/sharp-libvips-<platform>).",
      { cause: err },
    );
  }
  const probe = await normalize(PROBE_JPEG);
  if (probe.isErr()) {
    throw new Error(
      `sharp could not normalize a 1 × 1 JPEG (${probe.error}): the JPEG loader is missing or blocked.`,
    );
  }
}
