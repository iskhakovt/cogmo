import { describe, expect, it, vi } from "vitest";
import { AbortError } from "../util/with-retry.js";
import { ImageGenerationFailedError } from "./image-failure.js";
import { VeniceImageProvider } from "./venice.js";

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
    const fetchFn = mockFetch((_url, init) => {
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
      model: "m",
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
