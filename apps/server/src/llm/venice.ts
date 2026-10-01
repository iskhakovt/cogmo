/**
 * Hand-rolled adapter for Venice.ai's native `/image/generate` endpoint.
 *
 * Why not `@ai-sdk/openai-compatible`: Venice exposes an OpenAI-shape path
 * at `/v1/images/generations`, but it strict-rejects its own bespoke knobs
 * (`safe_mode`, `negative_prompt`, etc.) on that path with HTTP 400
 * (`Unrecognized key(s) in object`). The native path accepts them, returns
 * content-policy signals via response headers, and ships base64 image data
 * inline — different enough that going through the OpenAI-compat adapter
 * would mean either dropping Venice's additional parameters (negative prompts,
 * style presets) or fighting the SDK on every call.
 *
 * Response-header content-policy signals (HEAD-2 of the design):
 * - `x-venice-is-content-violation: true` → Venice rejected the prompt;
 *   throw a clear error so the LLM can rephrase.
 * - `x-venice-is-blurred: true` when `safe_mode` is true (default) →
 *   expected; the operator opted in to blur. Pass through.
 * - `x-venice-is-blurred: true` when `safe_mode` was explicitly false →
 *   the operator opted out of blur; an unwanted blur is a failed
 *   generation. Throw.
 *
 * Defaults are configured per-provider via `attrs.imageGenerationDefaults`
 * (set in the wizard / `cogmo image-provider` CLI). The LLM never picks
 * `safe_mode`, `cfg_scale`, etc. — those are operator-pinned policy.
 *
 * Sizing is per model. Venice's models listing (`GET /models?type=image`)
 * publishes each model's `model_spec.constraints`: a model with a non-empty
 * `aspectRatios` list takes `aspect_ratio` (the Qwen family rejects
 * `width`/`height` with a 400), and a model with no listed ratios is sized in
 * pixels, taking `width`/`height` in multiples of its `widthHeightDivisor`.
 * The adapter reads the listing to translate a requested aspect ratio into
 * whichever of the two the model takes — see `#sizingFields`.
 *
 * Endpoint shape (https://docs.venice.ai/api-reference/endpoint/image/generate):
 *   POST {baseUrl}/image/generate
 *   Authorization: Bearer <apiKey>
 *   Content-Type: application/json
 *   { model, prompt, [negative_prompt], [width], [height], [aspect_ratio],
 *     [seed], [safe_mode], [cfg_scale], [hide_watermark], [style_preset],
 *     format }
 *   → 200 OK
 *     headers: x-venice-is-blurred, x-venice-is-content-violation
 *     body: { images: ["<base64>", ...], ... }
 */

import * as R from "remeda";
import { z } from "zod";
import type { ImageGenerationDefaults } from "../agent/store/schema.js";
import { ImageGenerationFailedError } from "./image-failure.js";

/**
 * Venice's ceiling for `width` and `height` on `POST /image/generate`
 * (`maximum: 1280` on both in the endpoint's OpenAPI schema).
 */
export const VENICE_MAX_DIMENSION = 1280;

/**
 * Venice's default for `width` and `height` (`default: 1024` on both). A
 * pixel-sized model given an aspect ratio keeps this square's area, so
 * `1:1` lands exactly on the size Venice picks by default.
 */
const VENICE_DEFAULT_DIMENSION = 1024;

/**
 * How long one read of the models listing answers sizing questions. Venice
 * changes a model's constraints rarely; an hour bounds how long a process
 * keeps sizing a model the old way after it does.
 */
const MODEL_LISTING_TTL_MS = 60 * 60 * 1000;

/** The fields of a `/models?type=image` entry the adapter sizes requests from. */
const VeniceModelEntrySchema = z.object({
  id: z.string(),
  model_spec: z.object({
    constraints: z.object({
      aspectRatios: z.array(z.string()).optional(),
      widthHeightDivisor: z.number().int().min(1).max(VENICE_MAX_DIMENSION),
    }),
  }),
});

const VeniceModelListingSchema = z.object({ data: z.array(z.unknown()) });

/** How a model takes its size: an `aspect_ratio` token, or `width`/`height` in pixels. */
type VeniceSizing = { kind: "aspect_ratio" } | { kind: "pixels"; divisor: number };

/**
 * The `width`/`height` Venice should render `aspectRatio` (`"W:H"`) at on a
 * model sized in pixels: the area of Venice's default 1024×1024 reshaped to
 * the ratio, scaled down until the long side fits `VENICE_MAX_DIMENSION`,
 * and each side rounded to the nearest multiple of `divisor` within
 * `[divisor, VENICE_MAX_DIMENSION]`. Holding the area keeps every ratio near
 * the one-megapixel scale these models render at by default. Rounding moves
 * each side by at most half a `divisor`, so the result approximates the
 * ratio — unless a side hits the clamp, which only a ratio far beyond the
 * catalog's (`IMAGE_ALLOWED_ASPECT_RATIOS`) or a divisor that doesn't divide
 * 1280 can make it do.
 */
export function venicePixelSize(
  aspectRatio: string,
  divisor: number,
): { width: number; height: number } {
  const match = /^(\d+):(\d+)$/.exec(aspectRatio);
  const ratioWidth = Number(match?.[1]);
  const ratioHeight = Number(match?.[2]);
  if (!(ratioWidth > 0 && ratioHeight > 0)) {
    throw new Error(`venicePixelSize: "${aspectRatio}" is not a W:H aspect ratio`);
  }
  if (!Number.isInteger(divisor) || divisor < 1 || divisor > VENICE_MAX_DIMENSION) {
    throw new Error(`venicePixelSize: divisor ${divisor} is outside 1..${VENICE_MAX_DIMENSION}`);
  }
  const area = VENICE_DEFAULT_DIMENSION * VENICE_DEFAULT_DIMENSION;
  const width = Math.sqrt((area * ratioWidth) / ratioHeight);
  const height = Math.sqrt((area * ratioHeight) / ratioWidth);
  const scale = Math.min(1, VENICE_MAX_DIMENSION / Math.max(width, height));
  const ceiling = Math.floor(VENICE_MAX_DIMENSION / divisor) * divisor;
  const snap = (side: number): number =>
    Math.min(ceiling, Math.max(divisor, Math.round((side * scale) / divisor) * divisor));
  return { width: snap(width), height: snap(height) };
}

/** Wire-shape body sent to `POST /image/generate`. */
interface VeniceRequestBody {
  model: string;
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  aspect_ratio?: string;
  seed?: number;
  safe_mode?: boolean;
  cfg_scale?: number;
  hide_watermark?: boolean;
  style_preset?: string;
  /**
   * Output format. Defaulted to `"png"` so downstream consumers
   * (AttachmentStore, Telegram `sendPhoto`) get the same media type fal
   * returns. Venice's default is `"webp"` which is leaner on the wire but
   * fights Telegram's photo path (it ends up sent as a document).
   */
  format: "png" | "jpeg" | "webp";
}

/** The response body's field the adapter reads: base64 images, inline. */
const VeniceResponseSchema = z.object({ images: z.array(z.string()).optional() });

/**
 * Generation options the tool handler builds and hands to the adapter.
 * Mirrors the union of fields the LLM may pick (via the tool schema) plus
 * the provider-level defaults the adapter merges in at request time.
 */
export interface VeniceGenerateOptions {
  /** Provider model id, e.g. `"flux-dev"`. */
  model: string;
  prompt: string;
  /** Free-form "don't draw X". Gated on `capabilities.negativePrompt`. */
  negativePrompt?: string;
  /**
   * Aspect ratio token, e.g. `"16:9"`. Sent as `aspect_ratio` to a model
   * whose listing declares aspect ratios, and as `width`/`height` to a model
   * sized in pixels (see `venicePixelSize`).
   */
  aspectRatio?: string;
  /** Reproducibility seed; honored only when the model declares it. */
  seed?: number;
}

/** Result shape matching the AI SDK's `{ image }` so the tool handler can re-use the upload path. */
export interface VeniceGenerateResult {
  uint8Array: Uint8Array;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
}

const MEDIA_TYPE_BY_FORMAT: Record<VeniceRequestBody["format"], VeniceGenerateResult["mediaType"]> =
  {
    png: "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp",
  };

export interface VeniceImageProviderConfig {
  apiKey: string;
  /** Base URL including the API version path, e.g. `https://api.venice.ai/api/v1`. */
  baseUrl: string;
  /** Provider-level defaults from `image_providers.attrs.imageGenerationDefaults`. */
  defaults: ImageGenerationDefaults;
  /** Optional `fetch` override for integration tests (record/replay mock). */
  fetch?: typeof fetch;
}

/**
 * Encapsulates Venice's native image-generate call. One instance per
 * `image_providers` row; constructed in `buildImageProvider`. The tool
 * handler calls `generate(opts)` and consumes the AI-SDK-shaped
 * `{ uint8Array, mediaType }` result.
 */
export class VeniceImageProvider {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #defaults: ImageGenerationDefaults;
  readonly #fetch: typeof fetch;
  /**
   * Output format. Pinned to `"png"` for parity with fal — Telegram's
   * `sendPhoto` accepts png natively; webp falls back to document. If a
   * future need arises to expose this as a per-call knob, lift it into
   * the tool schema; today it's a provider invariant.
   */
  readonly #format: VeniceRequestBody["format"] = "png";
  /**
   * The models listing's sizing per model id, with when it was read. Shared
   * by concurrent calls while in flight; a read that fails is dropped, so the
   * next call reads again.
   */
  #listing: { readAt: number; sizing: Promise<ReadonlyMap<string, VeniceSizing>> } | undefined;

  constructor(config: VeniceImageProviderConfig) {
    this.#apiKey = config.apiKey;
    this.#baseUrl = config.baseUrl;
    this.#defaults = config.defaults;
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async generate(opts: VeniceGenerateOptions): Promise<VeniceGenerateResult> {
    const sizing =
      opts.aspectRatio === undefined ? {} : await this.#sizingFields(opts.model, opts.aspectRatio);
    const body: VeniceRequestBody = {
      model: opts.model,
      prompt: opts.prompt,
      format: this.#format,
      ...(opts.negativePrompt !== undefined && { negative_prompt: opts.negativePrompt }),
      ...sizing,
      ...(opts.seed !== undefined && { seed: opts.seed }),
      // Provider-level defaults the operator pinned (wizard / CLI). Only
      // forward fields the operator opted into so we don't accidentally
      // ship defaults Venice would reject on a model that doesn't support
      // them. Spread last so call-site overrides are impossible — these
      // are policy, not LLM-controlled.
      ...(this.#defaults.safe_mode !== undefined && { safe_mode: this.#defaults.safe_mode }),
      ...(this.#defaults.cfg_scale !== undefined && { cfg_scale: this.#defaults.cfg_scale }),
      ...(this.#defaults.hide_watermark !== undefined && {
        hide_watermark: this.#defaults.hide_watermark,
      }),
      ...(this.#defaults.style_preset !== undefined && {
        style_preset: this.#defaults.style_preset,
      }),
    };

    const url = `${this.#baseUrl}/image/generate`;
    const resp = await this.#fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    // Read the content-policy signals first so they survive a future Venice
    // change that ships content-violation as a 4xx. Venice currently
    // returns content-violation as 200 + header (`x-venice-is-content-violation: true`)
    // and the header survives whatever status code Venice picks — both
    // orderings are equivalent today, but probing headers first
    // guarantees the structured error reaches the LLM rather than the
    // generic "HTTP 4xx" string.
    const contentViolation = resp.headers.get("x-venice-is-content-violation") === "true";
    const blurred = resp.headers.get("x-venice-is-blurred") === "true";
    const safeModeRequested = this.#defaults.safe_mode !== false;

    if (contentViolation) {
      throw new ImageGenerationFailedError({
        kind: "moderation_blocked",
        provider: "venice",
        reason:
          "Venice rejected the prompt as a content policy violation " +
          "(x-venice-is-content-violation: true). Try rephrasing.",
      });
    }
    if (blurred && !safeModeRequested) {
      throw new ImageGenerationFailedError({
        kind: "blur_unexpected",
        provider: "venice",
        reason:
          "Venice returned a blurred image despite safe_mode=false " +
          "(x-venice-is-blurred: true). The provider applied a safety filter " +
          "that the operator opted out of; treating as a failed generation.",
      });
    }

    // 4xx → non-retryable, except 429 (rate limit) which is transient and
    // benefits from withRetry's exponential backoff. Bad keys (401),
    // unknown models (400), and quota issues (403) all retry-burn budget.
    // 429 and 5xx fall through to the default retry path, matching the AI
    // SDK's `APICallError.isRetryable` classification used on the fal/oai
    // path and `design/image-generation.md`'s retry-semantics spec.
    if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
      const detail = await resp.text().catch(() => "");
      throw new ImageGenerationFailedError({
        kind: "provider_error",
        provider: "venice",
        reason: `Venice image generation failed: HTTP ${resp.status}${detail ? ` — ${detail.slice(0, 500)}` : ""}`,
      });
    }
    if (!resp.ok) {
      throw new Error(`Venice image generation failed: HTTP ${resp.status}`);
    }

    const parsed = VeniceResponseSchema.safeParse(await resp.json());
    if (!parsed.success) {
      throw new Error(`Venice response did not match the expected shape: ${parsed.error.message}`);
    }
    const first = parsed.data.images?.[0];
    if (first === undefined || first.length === 0) {
      throw new Error("Venice response carried no image data");
    }
    // Buffer extends Uint8Array, so the `uint8Array` field contract is
    // satisfied directly — wrapping in `new Uint8Array(buffer, ...)` just
    // adds a view layer the caller would copy through anyway.
    const bytes = Buffer.from(first, "base64");
    return {
      uint8Array: bytes,
      mediaType: MEDIA_TYPE_BY_FORMAT[this.#format],
    };
  }

  /**
   * The request-body fields that carry `aspectRatio` for `model`. A model
   * the listing doesn't describe — absent, or an entry that doesn't parse —
   * fails the call before anything is generated: guessing a field could size
   * a pixel model wrong without a sign, the outcome a failed listing read
   * also refuses. The error tells the LLM to call again without a ratio.
   */
  async #sizingFields(
    model: string,
    aspectRatio: string,
  ): Promise<Pick<VeniceRequestBody, "aspect_ratio" | "width" | "height">> {
    const sizing = (await this.#modelSizing()).get(model);
    if (sizing === undefined) {
      throw new ImageGenerationFailedError({
        kind: "provider_error",
        provider: "venice",
        reason:
          `Venice's model listing (/models?type=image) has no usable entry for ${model}, ` +
          `so aspect ratio ${aspectRatio} can't be sized for it. Call again without aspectRatio.`,
      });
    }
    return sizing.kind === "aspect_ratio"
      ? { aspect_ratio: aspectRatio }
      : venicePixelSize(aspectRatio, sizing.divisor);
  }

  #modelSizing(): Promise<ReadonlyMap<string, VeniceSizing>> {
    const now = Date.now();
    if (this.#listing !== undefined && now - this.#listing.readAt < MODEL_LISTING_TTL_MS) {
      return this.#listing.sizing;
    }
    const listing = { readAt: now, sizing: this.#readModelSizing() };
    this.#listing = listing;
    // Drops the failed read from the cache; the caller still receives the
    // rejection through the promise returned below.
    listing.sizing.catch(() => {
      if (this.#listing === listing) this.#listing = undefined;
    });
    return listing.sizing;
  }

  /**
   * Read `GET /models?type=image` into each model's sizing. An entry that
   * doesn't parse is left out — the model then counts as undescribed —
   * rather than failing every sized call over one odd entry. HTTP failures
   * classify like `generate`'s: 4xx other than 429 is terminal, the rest is
   * left to the caller's retry.
   */
  async #readModelSizing(): Promise<ReadonlyMap<string, VeniceSizing>> {
    const resp = await this.#fetch(`${this.#baseUrl}/models?type=image`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        Accept: "application/json",
      },
    });
    if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
      throw new ImageGenerationFailedError({
        kind: "provider_error",
        provider: "venice",
        reason: `Venice model listing failed: HTTP ${resp.status}`,
      });
    }
    if (!resp.ok) {
      throw new Error(`Venice model listing failed: HTTP ${resp.status}`);
    }
    const listing = VeniceModelListingSchema.parse(await resp.json());
    return new Map(
      R.flatMap(listing.data, (raw): Array<[string, VeniceSizing]> => {
        const entry = VeniceModelEntrySchema.safeParse(raw);
        if (!entry.success) return [];
        const { aspectRatios, widthHeightDivisor } = entry.data.model_spec.constraints;
        const sizing: VeniceSizing =
          aspectRatios !== undefined && aspectRatios.length > 0
            ? { kind: "aspect_ratio" }
            : { kind: "pixels", divisor: widthHeightDivisor };
        return [[entry.data.id, sizing]];
      }),
    );
  }
}
