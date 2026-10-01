import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_ALLOWED_ASPECT_RATIOS } from "../agent/store/schema.js";
import { logger } from "../logger.js";
import { expectDefined } from "../test/assertions.js";
import { AbortError } from "../util/with-retry.js";
import { ImageGenerationFailedError } from "./image-failure.js";
import { VENICE_MAX_DIMENSION, VeniceImageProvider, venicePixelSize } from "./venice.js";

/**
 * Unit coverage for `VeniceImageProvider`:
 * - request body shape (path, headers, default merging)
 * - response handling (success, base64 decode)
 * - content-policy signals via response headers
 *   (`x-venice-is-content-violation`, `x-venice-is-blurred`)
 * - 4xx → AbortError (non-retryable)
 */

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
}

const ONE_PX_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const BASE_URL = "https://api.venice.ai/api/v1";
const LISTING_PATH = "/models?type=image";

/** A `/models?type=image` entry, trimmed to the fields the adapter reads plus a neighbour. */
function listingEntry(id: string, constraints: Record<string, unknown>) {
  return {
    id,
    object: "model",
    type: "image",
    model_spec: { constraints: { promptCharacterLimit: 1500, ...constraints }, traits: [] },
  };
}

/**
 * The listing's shape as Venice serves it: pixel-sized models list a
 * `widthHeightDivisor` and no `aspectRatios`; aspect-ratio models list both.
 */
const LISTING = {
  object: "list",
  type: "image",
  data: [
    listingEntry("chroma", { widthHeightDivisor: 8 }),
    listingEntry("venice-sd35", { widthHeightDivisor: 16 }),
    listingEntry("qwen-image", {
      aspectRatios: ["1:1", "3:2", "16:9", "21:9", "9:16", "2:3", "3:4", "4:5"],
      defaultAspectRatio: "1:1",
      widthHeightDivisor: 1,
    }),
    // No divisor: the entry doesn't parse, so the model counts as undescribed.
    listingEntry("odd-model", {}),
  ],
};

interface Captured {
  listingCalls: Array<{ url: string; init: RequestInit }>;
  generateBodies: Array<Record<string, unknown>>;
}

/**
 * A Venice stand-in routing the models listing and `/image/generate` apart.
 * `listing` answers each listing read in turn; the last answer repeats.
 */
function veniceFetch(listing: ReadonlyArray<() => Response> = [() => jsonResponse(LISTING)]): {
  fetchFn: typeof fetch;
  captured: Captured;
} {
  const captured: Captured = { listingCalls: [], generateBodies: [] };
  const fetchFn = mockFetch((url, init) => {
    if (url.endsWith(LISTING_PATH)) {
      const answer = listing[Math.min(captured.listingCalls.length, listing.length - 1)];
      captured.listingCalls.push({ url, init });
      if (answer === undefined) throw new Error("veniceFetch: no listing answer configured");
      return answer();
    }
    captured.generateBodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
    return jsonResponse({ images: [ONE_PX_PNG_BASE64] });
  });
  return { fetchFn, captured };
}

function provider(fetchFn: typeof fetch): VeniceImageProvider {
  return new VeniceImageProvider({
    apiKey: "sk-venice",
    baseUrl: BASE_URL,
    defaults: {},
    fetch: fetchFn,
  });
}

function jsonResponse(
  body: object,
  init: ResponseInit & { headers?: Record<string, string> } = {},
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("VeniceImageProvider.generate", () => {
  it("POSTs to {baseUrl}/image/generate with Bearer auth and the expected body shape", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchFn = mockFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse({ images: [ONE_PX_PNG_BASE64] });
    });

    const provider = new VeniceImageProvider({
      apiKey: "sk-venice",
      baseUrl: "https://api.venice.ai/api/v1",
      defaults: {},
      fetch: fetchFn,
    });

    const result = await provider.generate({
      model: "flux-dev",
      prompt: "a painted dragon",
    });

    expect(capturedUrl).toBe("https://api.venice.ai/api/v1/image/generate");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-venice");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "flux-dev",
      prompt: "a painted dragon",
      format: "png",
    });
    // No defaults set, no opt-in fields → don't ship them.
    expect(body).not.toHaveProperty("safe_mode");
    expect(body).not.toHaveProperty("cfg_scale");
    expect(body).not.toHaveProperty("negative_prompt");
    expect(result.mediaType).toBe("image/png");
    expect(result.uint8Array.byteLength).toBeGreaterThan(0);
  });

  it("forwards provider-level defaults (safe_mode, cfg_scale, hide_watermark, style_preset)", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchFn = mockFetch((_url, init) => {
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return jsonResponse({ images: [ONE_PX_PNG_BASE64] });
    });

    const provider = new VeniceImageProvider({
      apiKey: "sk",
      baseUrl: "https://api.venice.ai/api/v1",
      defaults: {
        safe_mode: false,
        cfg_scale: 7.5,
        hide_watermark: true,
        style_preset: "Anime",
      },
      fetch: fetchFn,
    });

    await provider.generate({ model: "m", prompt: "p" });
    expect(capturedBody).toMatchObject({
      safe_mode: false,
      cfg_scale: 7.5,
      hide_watermark: true,
      style_preset: "Anime",
    });
  });

  it("forwards per-call negativePrompt, aspectRatio, seed when supplied", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchFn = mockFetch((url, init) => {
      if (url.endsWith(LISTING_PATH)) return jsonResponse(LISTING);
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return jsonResponse({ images: [ONE_PX_PNG_BASE64] });
    });

    const provider = new VeniceImageProvider({
      apiKey: "sk",
      baseUrl: "https://api.venice.ai/api/v1",
      defaults: {},
      fetch: fetchFn,
    });

    await provider.generate({
      model: "qwen-image",
      prompt: "p",
      negativePrompt: "blurry, extra fingers",
      aspectRatio: "16:9",
      seed: 42,
    });
    expect(capturedBody).toMatchObject({
      negative_prompt: "blurry, extra fingers",
      aspect_ratio: "16:9",
      seed: 42,
    });
  });

  it("throws ImageGenerationFailedError (kind=moderation_blocked) on x-venice-is-content-violation", async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse(
        { images: [ONE_PX_PNG_BASE64] },
        { headers: { "x-venice-is-content-violation": "true" } },
      ),
    );

    const provider = new VeniceImageProvider({
      apiKey: "sk",
      baseUrl: "https://api.venice.ai/api/v1",
      defaults: {},
      fetch: fetchFn,
    });

    const promise = provider.generate({ model: "m", prompt: "p" });
    await expect(promise).rejects.toBeInstanceOf(ImageGenerationFailedError);
    // Still an AbortError too (via inheritance) so `withRetry` stops.
    await expect(promise).rejects.toBeInstanceOf(AbortError);
    await expect(promise).rejects.toMatchObject({
      failure: { kind: "moderation_blocked", provider: "venice" },
    });
  });

  it("throws ImageGenerationFailedError (kind=blur_unexpected) on x-venice-is-blurred when safe_mode=false", async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse({ images: [ONE_PX_PNG_BASE64] }, { headers: { "x-venice-is-blurred": "true" } }),
    );

    const provider = new VeniceImageProvider({
      apiKey: "sk",
      baseUrl: "https://api.venice.ai/api/v1",
      defaults: { safe_mode: false },
      fetch: fetchFn,
    });

    const promise = provider.generate({ model: "m", prompt: "p" });
    await expect(promise).rejects.toBeInstanceOf(ImageGenerationFailedError);
    await expect(promise).rejects.toMatchObject({
      failure: { kind: "blur_unexpected", provider: "venice" },
    });
  });

  it("passes through x-venice-is-blurred:true when safe_mode is default (true)", async () => {
    // Default safe_mode posture: operator opted in to blur — a blurred image
    // is the contract, not a failure. Pass through cleanly.
    const fetchFn = mockFetch(() =>
      jsonResponse({ images: [ONE_PX_PNG_BASE64] }, { headers: { "x-venice-is-blurred": "true" } }),
    );

    const provider = new VeniceImageProvider({
      apiKey: "sk",
      baseUrl: "https://api.venice.ai/api/v1",
      defaults: {}, // safe_mode unset → Venice default (true) → blur expected
      fetch: fetchFn,
    });

    const result = await provider.generate({ model: "m", prompt: "p" });
    expect(result.uint8Array.byteLength).toBeGreaterThan(0);
  });

  it("throws ImageGenerationFailedError (kind=provider_error) on HTTP 4xx (non-retryable)", async () => {
    const fetchFn = mockFetch(
      () =>
        new Response(JSON.stringify({ error: "invalid API key" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const provider = new VeniceImageProvider({
      apiKey: "sk",
      baseUrl: "https://api.venice.ai/api/v1",
      defaults: {},
      fetch: fetchFn,
    });

    const promise = provider.generate({ model: "m", prompt: "p" });
    await expect(promise).rejects.toBeInstanceOf(ImageGenerationFailedError);
    await expect(promise).rejects.toBeInstanceOf(AbortError);
    await expect(promise).rejects.toMatchObject({
      failure: { kind: "provider_error", provider: "venice" },
    });
    await expect(promise).rejects.toThrow(/HTTP 401/);
  });

  it("throws a plain Error (retryable) on HTTP 429 — rate limit is transient", async () => {
    // 429 is the only 4xx that benefits from withRetry's exponential
    // backoff. Promoting it to AbortError (as bad keys, unknown models,
    // and quota errors are) would fail the call after a rate-limit blip
    // that would have cleared on the next attempt.
    const fetchFn = mockFetch(
      () =>
        new Response(JSON.stringify({ error: "rate limit exceeded" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const provider = new VeniceImageProvider({
      apiKey: "sk",
      baseUrl: "https://api.venice.ai/api/v1",
      defaults: {},
      fetch: fetchFn,
    });

    const result = provider.generate({ model: "m", prompt: "p" });
    await expect(result).rejects.toThrow(/HTTP 429/);
    await expect(result).rejects.not.toBeInstanceOf(AbortError);
  });

  it("throws a plain Error on 5xx (retryable upstream)", async () => {
    const fetchFn = mockFetch(() => new Response("upstream is down", { status: 503 }));

    const provider = new VeniceImageProvider({
      apiKey: "sk",
      baseUrl: "https://api.venice.ai/api/v1",
      defaults: {},
      fetch: fetchFn,
    });

    // 5xx is retryable — fall back to a plain Error so the outer withRetry
    // re-attempts. AbortError would short-circuit the retry loop.
    await expect(provider.generate({ model: "m", prompt: "p" })).rejects.not.toBeInstanceOf(
      AbortError,
    );
    await expect(provider.generate({ model: "m", prompt: "p" })).rejects.toThrow(/HTTP 503/);
  });

  it("throws when the response carries no image data", async () => {
    const fetchFn = mockFetch(() => jsonResponse({ images: [] }));

    const provider = new VeniceImageProvider({
      apiKey: "sk",
      baseUrl: "https://api.venice.ai/api/v1",
      defaults: {},
      fetch: fetchFn,
    });

    await expect(provider.generate({ model: "m", prompt: "p" })).rejects.toThrow(/no image data/);
  });
});

describe("venicePixelSize", () => {
  it.each([
    ["1:1", 8, { width: 1024, height: 1024 }],
    ["1:1", 16, { width: 1024, height: 1024 }],
    ["16:9", 8, { width: 1280, height: 720 }],
    ["9:16", 8, { width: 720, height: 1280 }],
    ["4:3", 8, { width: 1184, height: 888 }],
    ["3:4", 8, { width: 888, height: 1184 }],
    ["4:3", 16, { width: 1184, height: 880 }],
    ["21:9", 8, { width: 1280, height: 552 }],
    ["9:21", 8, { width: 552, height: 1280 }],
    ["21:9", 16, { width: 1280, height: 544 }],
  ])("sizes %s at divisor %d as %o", (ratio, divisor, expected) => {
    expect(venicePixelSize(ratio, divisor)).toEqual(expected);
  });

  // Every ratio the catalog can declare, at the divisors Venice publishes
  // (1, 8, 16) and a coarser one.
  const cases = IMAGE_ALLOWED_ASPECT_RATIOS.flatMap((ratio) =>
    [1, 8, 16, 64].map((divisor) => [ratio, divisor] as const),
  );

  it.each(cases)("sizes %s at divisor %d inside Venice's limits", (ratio, divisor) => {
    const { width, height } = venicePixelSize(ratio, divisor);
    for (const side of [width, height]) {
      expect(Number.isInteger(side)).toBe(true);
      expect(side % divisor).toBe(0);
      expect(side).toBeGreaterThanOrEqual(divisor);
      expect(side).toBeLessThanOrEqual(VENICE_MAX_DIMENSION);
    }
    const [rw = 0, rh = 0] = ratio.split(":").map(Number);
    // The long side sits at the cap, or the area stays near 1024×1024.
    const atCap = Math.max(width, height) === VENICE_MAX_DIMENSION;
    expect(atCap || Math.abs(width * height - 1024 * 1024) <= 1024 * 1024 * 0.15).toBe(true);
    // Rounding moves each side at most half a divisor, which bounds how far
    // the result can drift from the exact ratio.
    expect(Math.abs(width * rh - height * rw)).toBeLessThanOrEqual((divisor * (rw + rh)) / 2);
  });

  it("rounds down at the ceiling when the divisor doesn't divide 1280", () => {
    // 1280 / 3 = 426.7 rounds up to 427 × 3 = 1281, past Venice's cap.
    expect(venicePixelSize("16:9", 3)).toEqual({ width: 1278, height: 720 });
  });

  it("never rounds a side to zero", () => {
    expect(venicePixelSize("1000:1", 8)).toEqual({ width: 1280, height: 8 });
  });

  it.each(["wide", "16:0", "0:9", "16/9", ""])("throws on the malformed ratio %j", (ratio) => {
    expect(() => venicePixelSize(ratio, 8)).toThrow(/not a W:H aspect ratio/);
  });

  it.each([0, -8, 2.5, VENICE_MAX_DIMENSION + 1])("throws on the divisor %d", (divisor) => {
    expect(() => venicePixelSize("1:1", divisor)).toThrow(/divisor/);
  });
});

describe("VeniceImageProvider.generate — aspect ratio sizing", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends width/height for a model sized in pixels, rounded to its divisor", async () => {
    const { fetchFn, captured } = veniceFetch();

    await provider(fetchFn).generate({ model: "chroma", prompt: "p", aspectRatio: "9:16" });

    expect(captured.generateBodies).toHaveLength(1);
    const body = captured.generateBodies[0];
    expect(body).toMatchObject({ model: "chroma", width: 720, height: 1280 });
    expect(body).not.toHaveProperty("aspect_ratio");
  });

  it("uses each model's own divisor", async () => {
    const { fetchFn, captured } = veniceFetch();

    await provider(fetchFn).generate({ model: "venice-sd35", prompt: "p", aspectRatio: "4:3" });

    expect(captured.generateBodies[0]).toMatchObject({ width: 1184, height: 880 });
  });

  it("sends aspect_ratio, not width/height, to a model whose listing declares ratios", async () => {
    const { fetchFn, captured } = veniceFetch();

    await provider(fetchFn).generate({ model: "qwen-image", prompt: "p", aspectRatio: "16:9" });

    const body = captured.generateBodies[0];
    expect(body).toMatchObject({ aspect_ratio: "16:9" });
    expect(body).not.toHaveProperty("width");
    expect(body).not.toHaveProperty("height");
  });

  it.each([
    ["missing from the listing", "not-listed"],
    ["whose entry doesn't parse", "odd-model"],
  ])("sends aspect_ratio unchanged for a model %s, and warns", async (_label, model) => {
    const warn = vi.spyOn(logger, "warn");
    const { fetchFn, captured } = veniceFetch();

    await provider(fetchFn).generate({ model, prompt: "p", aspectRatio: "16:9" });

    expect(captured.generateBodies[0]).toMatchObject({ aspect_ratio: "16:9" });
    expect(captured.generateBodies[0]).not.toHaveProperty("width");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ model, aspectRatio: "16:9" }),
      expect.stringContaining("/models?type=image"),
    );
  });

  it("reads the listing from {baseUrl}/models?type=image with Bearer auth", async () => {
    const { fetchFn, captured } = veniceFetch();

    await provider(fetchFn).generate({ model: "chroma", prompt: "p", aspectRatio: "1:1" });

    expect(captured.listingCalls).toHaveLength(1);
    const call = expectDefined(captured.listingCalls[0], "listing call");
    expect(call.url).toBe(`${BASE_URL}/models?type=image`);
    expect(call.init.method).toBe("GET");
    expect(call.init.headers).toMatchObject({ Authorization: "Bearer sk-venice" });
  });

  it("doesn't read the listing for a call without an aspect ratio", async () => {
    const { fetchFn, captured } = veniceFetch();

    await provider(fetchFn).generate({ model: "chroma", prompt: "p" });

    expect(captured.listingCalls).toHaveLength(0);
    const body = captured.generateBodies[0];
    expect(body).not.toHaveProperty("aspect_ratio");
    expect(body).not.toHaveProperty("width");
    expect(body).not.toHaveProperty("height");
  });

  it("reads the listing once for sequential and concurrent calls within the hour", async () => {
    const { fetchFn, captured } = veniceFetch();
    const venice = provider(fetchFn);

    await Promise.all([
      venice.generate({ model: "chroma", prompt: "a", aspectRatio: "16:9" }),
      venice.generate({ model: "qwen-image", prompt: "b", aspectRatio: "16:9" }),
    ]);
    await venice.generate({ model: "venice-sd35", prompt: "c", aspectRatio: "1:1" });

    expect(captured.listingCalls).toHaveLength(1);
    expect(captured.generateBodies).toHaveLength(3);
  });

  it("reads the listing again once an hour has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const pixelsThenRatios = {
      ...LISTING,
      data: [listingEntry("chroma", { widthHeightDivisor: 8 })],
    };
    const ratiosNow = {
      ...LISTING,
      data: [listingEntry("chroma", { aspectRatios: ["16:9"], widthHeightDivisor: 1 })],
    };
    const { fetchFn, captured } = veniceFetch([
      () => jsonResponse(pixelsThenRatios),
      () => jsonResponse(ratiosNow),
    ]);
    const venice = provider(fetchFn);

    await venice.generate({ model: "chroma", prompt: "p", aspectRatio: "16:9" });
    vi.setSystemTime(new Date("2026-10-01T12:59:59Z"));
    await venice.generate({ model: "chroma", prompt: "p", aspectRatio: "16:9" });
    vi.setSystemTime(new Date("2026-10-01T13:00:00Z"));
    await venice.generate({ model: "chroma", prompt: "p", aspectRatio: "16:9" });

    expect(captured.listingCalls).toHaveLength(2);
    expect(captured.generateBodies.map((b) => b.aspect_ratio ?? `${b.width}x${b.height}`)).toEqual([
      "1280x720",
      "1280x720",
      "16:9",
    ]);
  });

  it("fails retryably on a 5xx listing without generating, then reads the listing again", async () => {
    const { fetchFn, captured } = veniceFetch([
      () => new Response("upstream is down", { status: 503 }),
      () => jsonResponse(LISTING),
    ]);
    const venice = provider(fetchFn);

    const first = venice.generate({ model: "chroma", prompt: "p", aspectRatio: "16:9" });
    await expect(first).rejects.toThrow(/model listing failed: HTTP 503/);
    await expect(first).rejects.not.toBeInstanceOf(AbortError);
    expect(captured.generateBodies).toHaveLength(0);

    await venice.generate({ model: "chroma", prompt: "p", aspectRatio: "16:9" });
    expect(captured.listingCalls).toHaveLength(2);
    expect(captured.generateBodies[0]).toMatchObject({ width: 1280, height: 720 });
  });

  it("fails terminally on a 4xx listing (other than 429) without generating", async () => {
    const { fetchFn, captured } = veniceFetch([() => new Response("not found", { status: 404 })]);

    const promise = provider(fetchFn).generate({
      model: "chroma",
      prompt: "p",
      aspectRatio: "16:9",
    });

    await expect(promise).rejects.toBeInstanceOf(ImageGenerationFailedError);
    await expect(promise).rejects.toMatchObject({
      failure: { kind: "provider_error", provider: "venice" },
    });
    await expect(promise).rejects.toThrow(/model listing failed: HTTP 404/);
    expect(captured.generateBodies).toHaveLength(0);
  });

  it("fails retryably on a 429 listing", async () => {
    const { fetchFn } = veniceFetch([() => new Response("slow down", { status: 429 })]);

    const promise = provider(fetchFn).generate({
      model: "chroma",
      prompt: "p",
      aspectRatio: "16:9",
    });

    await expect(promise).rejects.toThrow(/HTTP 429/);
    await expect(promise).rejects.not.toBeInstanceOf(AbortError);
  });

  it("fails on a listing that isn't the documented shape", async () => {
    const { fetchFn, captured } = veniceFetch([() => jsonResponse({ models: [] })]);

    await expect(
      provider(fetchFn).generate({ model: "chroma", prompt: "p", aspectRatio: "16:9" }),
    ).rejects.toThrow();
    expect(captured.generateBodies).toHaveLength(0);
  });
});
