/**
 * Live: a request of 21 normalized 2000-px images (design/transport/
 * attachments.md → Tests → Live). Above 20 images in a request Anthropic asks
 * that neither dimension exceed 2000 px; normalization fits every image to
 * that, so the request is accepted whatever the count.
 *
 * Skipped unless `LIVE=1` and `ANTHROPIC_API_KEY` are set. Costs about
 * 35k input tokens per model.
 *
 *   set -a; . ./.env; set +a; LIVE=1 pnpm test:live
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../llm/anthropic.js";
import type { ContentBlock } from "../../llm/types.js";
import { expectOk } from "../../test/assertions.js";
import { normalizeImage } from "./normalize-image.js";

// An empty `ANTHROPIC_API_KEY=` line in `.env` counts as unset.
const API_KEY = (process.env.LIVE === "1" && process.env.ANTHROPIC_API_KEY) || undefined;

const IMAGES = 21;

/** A 3000 × 3000 gradient in its own colour, which normalizes to 2000 × 2000. */
async function photo(i: number): Promise<Buffer> {
  const side = 3000;
  const pixels = Buffer.alloc(side * side * 3);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const at = (y * side + x) * 3;
      pixels[at] = (i * 12) % 256;
      pixels[at + 1] = Math.floor((255 * x) / side);
      pixels[at + 2] = Math.floor((255 * y) / side);
    }
  }
  // Raw pixels take no loader, so the allowlist doesn't apply.
  return sharp(pixels, { raw: { width: side, height: side, channels: 3 } })
    .jpeg()
    .toBuffer();
}

describe.skipIf(API_KEY === undefined)("many normalized images (live)", () => {
  it.each(["claude-haiku-4-5", "claude-sonnet-5"])(
    "%s accepts 21 normalized 2000-px images in one request",
    { timeout: 180_000 },
    async (model) => {
      const images: ContentBlock[] = [];
      for (let i = 0; i < IMAGES; i++) {
        const normalized = expectOk(await normalizeImage(await photo(i)));
        expect(Math.max(normalized.width, normalized.height)).toBe(2000);
        images.push({
          type: "image",
          source: "base64",
          data: normalized.data.toString("base64"),
          mediaType: normalized.mediaType,
          width: normalized.width,
          height: normalized.height,
        });
      }
      const provider = new AnthropicProvider(API_KEY ?? "", undefined, {});
      const response = await provider.chat({
        model,
        system: "Answer with a number only.",
        maxTokens: 16,
        messages: [
          {
            role: "user",
            content: [...images, { type: "text", text: "How many images are there?" }],
          },
        ],
      });
      expect(response.stopReason).not.toBe("error");
      expect(response.content.some((b) => b.type === "text")).toBe(true);
    },
  );
});
