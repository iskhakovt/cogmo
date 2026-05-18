import type { GenerateImageResult } from "ai";
import { describe, expect, it } from "vitest";
import {
  detectImageFailure,
  type ImageProviderKind,
  SUSPICIOUS_SIZE_THRESHOLD_BYTES,
} from "./image-moderation.js";

type GeneratedImage = GenerateImageResult["image"];

function image(byteLength: number, mediaType = "image/png"): GeneratedImage {
  const bytes = new Uint8Array(byteLength);
  bytes.fill(0xff);
  return {
    uint8Array: bytes,
    mediaType,
    // GeneratedFile carries `base64` / `mimeType` too; tests only read
    // `uint8Array` + `mediaType` via `detectImageFailure`, so a minimal
    // stub is enough — bridge via `unknown` because we're deliberately
    // omitting fields the SDK shape declares.
  } as unknown as GeneratedImage;
}

const HEALTHY_BYTES = SUSPICIOUS_SIZE_THRESHOLD_BYTES * 50;

describe("detectImageFailure — fal", () => {
  const kind: ImageProviderKind = "fal";

  it("returns ok for a healthy image with no nsfw flag", () => {
    const result = detectImageFailure({
      image: image(HEALTHY_BYTES),
      providerMetadata: { fal: { images: [{ nsfw: false }] } },
      providerKind: kind,
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns ok when providerMetadata is absent (size still healthy)", () => {
    const result = detectImageFailure({
      image: image(HEALTHY_BYTES),
      providerMetadata: undefined,
      providerKind: kind,
    });
    expect(result).toEqual({ ok: true });
  });

  it("flags an image whose per-image `nsfw` is true", () => {
    const result = detectImageFailure({
      image: image(HEALTHY_BYTES),
      providerMetadata: { fal: { images: [{ nsfw: true }] } },
      providerKind: kind,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/flagged as nsfw by fal/);
      // No concepts available — reason should still be useful.
      expect(result.reason).not.toMatch(/concepts:/);
    }
  });

  it("includes concept names when fal returns nsfw_concepts", () => {
    const result = detectImageFailure({
      image: image(HEALTHY_BYTES),
      providerMetadata: {
        fal: {
          images: [{ nsfw: true }],
          nsfw_concepts: ["nudity", "violence"],
        },
      },
      providerKind: kind,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/concepts: nudity, violence/);
    }
  });

  it("flags when ANY image in a multi-image response is nsfw", () => {
    const result = detectImageFailure({
      image: image(HEALTHY_BYTES),
      providerMetadata: {
        fal: { images: [{ nsfw: false }, { nsfw: true }] },
      },
      providerKind: kind,
    });
    expect(result.ok).toBe(false);
  });

  it("falls back gracefully on malformed providerMetadata.fal", () => {
    const result = detectImageFailure({
      image: image(HEALTHY_BYTES),
      // @ts-expect-error — `images: "not-an-array"` deliberately violates
      // the schema. The defensive Zod parse must absorb this without
      // throwing; an unsafe cast would erase the type signal entirely.
      providerMetadata: { fal: { images: "not-an-array" } },
      providerKind: kind,
    });
    // Schema parse fails → no nsfw branch fires → size canary checks → healthy.
    expect(result).toEqual({ ok: true });
  });

  it("falls back gracefully when providerMetadata.fal is missing", () => {
    const result = detectImageFailure({
      image: image(HEALTHY_BYTES),
      providerMetadata: {},
      providerKind: kind,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("detectImageFailure — size canary (all providers)", () => {
  it("fails when bytes are below the suspicious threshold", () => {
    const tinyBytes = SUSPICIOUS_SIZE_THRESHOLD_BYTES - 1;
    const result = detectImageFailure({
      image: image(tinyBytes),
      providerMetadata: undefined,
      providerKind: "fal",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(new RegExp(`${tinyBytes} bytes`));
      expect(result.reason).toMatch(/likely a placeholder/);
    }
  });

  it("fails on undersized images regardless of provider kind", () => {
    const result = detectImageFailure({
      image: image(100),
      providerMetadata: undefined,
      providerKind: "oai",
    });
    expect(result.ok).toBe(false);
  });

  it("passes at exactly the threshold (boundary)", () => {
    // < threshold fails, >= passes.
    const result = detectImageFailure({
      image: image(SUSPICIOUS_SIZE_THRESHOLD_BYTES),
      providerMetadata: undefined,
      providerKind: "fal",
    });
    expect(result).toEqual({ ok: true });
  });

  it("prefers the nsfw reason over the size reason when both fire", () => {
    // Flagged AND tiny — nsfw is the more actionable hint.
    const result = detectImageFailure({
      image: image(100),
      providerMetadata: {
        fal: { images: [{ nsfw: true }], nsfw_concepts: ["nudity"] },
      },
      providerKind: "fal",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/flagged as nsfw/);
      expect(result.reason).not.toMatch(/suspiciously small/);
    }
  });
});

describe("detectImageFailure — non-fal providers", () => {
  it("ignores any nsfw flags in providerMetadata for `oai` kind", () => {
    // Today the oai branch has no provider-specific signal — even if a
    // venice-shaped payload were attached to providerMetadata.fal, the
    // detector should not read it for kind=oai. Size still applies.
    const result = detectImageFailure({
      image: image(HEALTHY_BYTES),
      providerMetadata: {
        fal: { images: [{ nsfw: true }] },
      },
      providerKind: "oai",
    });
    expect(result).toEqual({ ok: true });
  });
});
