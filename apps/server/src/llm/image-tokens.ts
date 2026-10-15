/**
 * Per-model image token estimates for routes whose count is local — see
 * design/context-management.md → Images on OpenAI-compatible routes.
 */

import * as R from "remeda";
import { match } from "ts-pattern";
import type { ImageBlock } from "./types.js";

/** An image's pixel size, when its block carries one. */
type ImageSize = Pick<ImageBlock, "width" | "height">;

type ImageFamily = Readonly<
  | { kind: "claude" }
  | { kind: "gemini" }
  // The multiplier in hundredths, so the product is exact.
  | { kind: "openai-patch"; multiplierPct: number }
  | { kind: "openai-tile"; base: number; perTile: number }
  | { kind: "other" }
>;

/** Claude's per-image cap, in tokens: the most 28-px patches it keeps. */
const CLAUDE_MAX_TOKENS = 4_784;
/** Gemini 3's default per-image budget, the floor of the Gemini estimate. */
const GEMINI_MIN_TOKENS = 1_120;
/**
 * Gemini 3's largest per-image budget (`ultra_high`), the cap of the Gemini
 * estimate: the tiling formula grows without bound as an image thins.
 */
const GEMINI_MAX_TOKENS = 2_240;
const GEMINI_TILE_TOKENS = 258;

/**
 * Stored images are normalized to at most 2000 px a side. An image without
 * dimensions counts at its formula's most over that range: 4,784 on Claude,
 * Gemini's cap of 2,240, and the larger of the two on any other model.
 * OpenAI's patch count peaks at 2000 × 2000, 3,969 patches times the
 * multiplier (4,763 at 1.2). Its tile count peaks at 8 tiles, as for
 * 2000 × 800, which fits to 1920 × 768.
 */
const NORMALIZED_MAX_PX = 2_000;
const OPENAI_TILE_MAX_TILES = 8;

/** The tokens one image adds to a request to `model`. */
export function estimateImageTokens(model: string, image: ImageSize): number {
  const family = imageFamily(model);
  const size =
    image.width !== undefined && image.height !== undefined
      ? { w: image.width, h: image.height }
      : undefined;
  return match(family)
    .with({ kind: "claude" }, () => claudeTokens(size))
    .with({ kind: "gemini" }, () => geminiTokens(size))
    .with({ kind: "openai-patch" }, ({ multiplierPct }) => {
      const { w, h } = size ?? { w: NORMALIZED_MAX_PX, h: NORMALIZED_MAX_PX };
      return Math.ceil((Math.ceil(w / 32) * Math.ceil(h / 32) * multiplierPct) / 100);
    })
    .with(
      { kind: "openai-tile" },
      ({ base, perTile }) =>
        base + perTile * (size ? openAITiles(size.w, size.h) : OPENAI_TILE_MAX_TILES),
    )
    .with({ kind: "other" }, () => Math.max(claudeTokens(size), geminiTokens(size)))
    .exhaustive();
}

function claudeTokens(size: { w: number; h: number } | undefined): number {
  if (!size) return CLAUDE_MAX_TOKENS;
  return Math.min(CLAUDE_MAX_TOKENS, Math.ceil(size.w / 28) * Math.ceil(size.h / 28));
}

function geminiTokens(size: { w: number; h: number } | undefined): number {
  if (!size) return GEMINI_MAX_TOKENS;
  // A side under 2 px would make the unit zero.
  const unit = Math.max(1, Math.floor(Math.min(size.w, size.h) / 1.5));
  const tiles = Math.ceil(size.w / unit) * Math.ceil(size.h / unit);
  return R.clamp(tiles * GEMINI_TILE_TOKENS, { min: GEMINI_MIN_TOKENS, max: GEMINI_MAX_TOKENS });
}

/** 512-px tiles after fitting within 2048 × 2048, then to a short side of at most 768. */
function openAITiles(w: number, h: number): number {
  const fit = Math.min(1, 2048 / Math.max(w, h));
  const short = Math.min(1, 768 / (Math.min(w, h) * fit));
  const scale = fit * short;
  return Math.ceil(Math.round(w * scale) / 512) * Math.ceil(Math.round(h * scale) / 512);
}

/** The estimate's row for `model`, by its id's provider prefix or OpenAI model id. */
function imageFamily(model: string): ImageFamily {
  const slug = model.startsWith("~") ? model.slice(1) : model;
  if (slug.startsWith("anthropic/") || slug.startsWith("claude-")) return { kind: "claude" };
  if (slug.startsWith("google/") || slug.startsWith("gemini-")) return { kind: "gemini" };
  const id = slug.replace(/^openai\//, "").replace(/^ft:/, "");
  return openAIFamily(id) ?? { kind: "other" };
}

/** OpenAI's rows, longest id first so `gpt-5.1` doesn't read as `gpt-5`. */
const OPENAI_FAMILIES: ReadonlyArray<readonly [RegExp, ImageFamily]> = [
  [/^gpt-5-mini/, { kind: "openai-patch", multiplierPct: 120 }],
  [/^gpt-5-nano/, { kind: "openai-patch", multiplierPct: 150 }],
  [/^gpt-4\.1-mini/, { kind: "openai-patch", multiplierPct: 162 }],
  [/^gpt-4\.1-nano/, { kind: "openai-patch", multiplierPct: 246 }],
  [/^o4-mini/, { kind: "openai-patch", multiplierPct: 172 }],
  [/^gpt-6-astra/, { kind: "openai-patch", multiplierPct: 120 }],
  [/^gpt-5\.[2456](?!\d)/, { kind: "openai-patch", multiplierPct: 120 }],
  [/^gpt-4o-mini/, { kind: "openai-tile", base: 2_833, perTile: 5_667 }],
  [/^gpt-4o/, { kind: "openai-tile", base: 85, perTile: 170 }],
  [/^gpt-4\.1(?![.\d])/, { kind: "openai-tile", base: 85, perTile: 170 }],
  [/^gpt-5\.1(?!\d)/, { kind: "openai-tile", base: 70, perTile: 140 }],
  [/^gpt-5(?![.\d])/, { kind: "openai-tile", base: 70, perTile: 140 }],
  [/^o[13](?!\d)/, { kind: "openai-tile", base: 75, perTile: 150 }],
];

function openAIFamily(id: string): ImageFamily | undefined {
  return OPENAI_FAMILIES.find(([pattern]) => pattern.test(id))?.[1];
}
