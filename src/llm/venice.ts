/**
 * Hand-rolled adapter for Venice.ai's native `/image/generate` endpoint.
 *
 * Why not `@ai-sdk/openai-compatible`: Venice exposes an OpenAI-shape path
 * at `/v1/images/generations`, but it strict-rejects its own bespoke knobs
 * (`safe_mode`, `negative_prompt`, etc.) on that path with HTTP 400
 * (`Unrecognized key(s) in object`). The native path accepts them, returns
 * censorship signals via response headers, and ships base64 image data
 * inline — different enough that going through the OpenAI-compat adapter
 * would mean either dropping Venice's value-add (uncensored output,
 * negative prompts) or fighting the SDK on every call.
 *
 * Response-header censorship signals (HEAD-2 of the design):
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

import type { ImageGenerationDefaults } from "../agent/store/schema.js";
import { AbortError } from "../util/with-retry.js";

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

/** Wire-shape response body. Venice returns base64 images inline. */
interface VeniceResponseBody {
  images?: ReadonlyArray<string>;
  /** Echoed back for some models — informational only, we don't consume. */
  request?: unknown;
}

/**
 * Generation options the tool handler builds and hands to the adapter.
 * Mirrors the union of fields the LLM may pick (via the tool schema) plus
 * the provider-level defaults the adapter merges in at request time.
 */
export interface VeniceGenerateOptions {
  /** Provider model id, e.g. `"flux-dev-uncensored"`. */
  model: string;
  prompt: string;
  /** Free-form "don't draw X". Gated on `capabilities.negativePrompt`. */
  negativePrompt?: string;
  /** Aspect ratio token, e.g. `"16:9"`. Forwarded as-is. */
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

  constructor(config: VeniceImageProviderConfig) {
    this.#apiKey = config.apiKey;
    this.#baseUrl = config.baseUrl;
    this.#defaults = config.defaults;
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async generate(opts: VeniceGenerateOptions): Promise<VeniceGenerateResult> {
    const body: VeniceRequestBody = {
      model: opts.model,
      prompt: opts.prompt,
      format: this.#format,
      ...(opts.negativePrompt !== undefined && { negative_prompt: opts.negativePrompt }),
      ...(opts.aspectRatio !== undefined && { aspect_ratio: opts.aspectRatio }),
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

    // Read the censorship signals first so they survive a future Venice
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
      throw new AbortError(
        "Venice rejected the prompt as a content policy violation " +
          "(x-venice-is-content-violation: true). Try rephrasing.",
      );
    }
    if (blurred && !safeModeRequested) {
      throw new AbortError(
        "Venice returned a blurred image despite safe_mode=false " +
          "(x-venice-is-blurred: true). The provider applied a safety filter " +
          "that the operator opted out of; treating as a failed generation.",
      );
    }

    // 4xx → non-retryable, except 429 (rate limit) which is transient and
    // benefits from withRetry's exponential backoff. Bad keys (401),
    // unknown models (400), and quota issues (403) all retry-burn budget.
    // 429 and 5xx fall through to the default retry path, matching the AI
    // SDK's `APICallError.isRetryable` classification used on the fal/oai
    // path and `design/image-generation.md`'s retry-semantics spec.
    if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
      const detail = await resp.text().catch(() => "");
      throw new AbortError(
        `Venice image generation failed: HTTP ${resp.status}${detail ? ` — ${detail.slice(0, 500)}` : ""}`,
      );
    }
    if (!resp.ok) {
      throw new Error(`Venice image generation failed: HTTP ${resp.status}`);
    }

    const parsed = (await resp.json()) as VeniceResponseBody;
    const first = parsed.images?.[0];
    if (typeof first !== "string" || first.length === 0) {
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
}
