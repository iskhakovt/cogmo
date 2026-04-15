/**
 * Scoped `fetch` interceptor for fal.ai HTTP traffic — record/replay for
 * integration tests.
 *
 * llmock (`@copilotkit/aimock`) is LLM-API specific (Anthropic messages, OpenAI
 * chat/completions, embeddings) and doesn't cover fal's queue/CDN pattern.
 * This module fills the gap with a fetch wrapper that intercepts fal endpoints
 * and delegates everything else to global fetch.
 *
 * Why a custom fetch, not MSW:
 * - `@ai-sdk/fal` accepts a `fetch` option at construction. Passing a custom
 *   function is strictly scoped to fal calls — no global patching.
 * - MSW patches `globalThis.fetch`, which caused issues with the Anthropic
 *   SDK's streaming requests going through llmock (the auth header ended up
 *   mangled via MSW's bypass path).
 * - Tests for other providers (Anthropic via llmock, S3 via MinIO) are
 *   completely unaffected by this module.
 *
 * Strategy:
 * - Intercept `POST https://fal.run/fal-ai/*` — the image model's sync endpoint.
 * - Intercept `GET https://fal.media-mock.test/*` — a stable local mock CDN.
 *   Record mode rewrites the real CDN URL (UUID-per-call) to this stable host
 *   so replay-mode fixtures have deterministic URLs.
 *
 * Modes:
 * - **replay** (default, CI): loads `{key}.json` + `{key}.{ext}` from disk.
 *   Unmatched fal-ish traffic returns 503 (strict, like llmock).
 * - **record** (local, `RECORD=1 FAL_API_KEY=...`): passes through to real
 *   fal.ai, captures response + image bytes, writes both fixtures, returns
 *   the rewritten response to the SDK so it then hits our mock CDN for bytes.
 *
 * Fixture key: `{model-slug}-{sha256(model:prompt:image_size:seed):12}`.
 * Stable across runs for the same input, collision-safe across different inputs.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FAL_HOST = "https://fal.run";
const MOCK_CDN_HOST = "https://fal.media-mock.test";

interface FalRequestBody {
  prompt: string;
  image_size?: string | { width: number; height: number };
  seed?: number;
}

interface FalImage {
  url: string;
  content_type?: string;
  width?: number;
  height?: number;
}

interface FalResponse {
  images: FalImage[];
  [key: string]: unknown;
}

function imageSizeKey(imageSize: FalRequestBody["image_size"]): string {
  if (!imageSize) return "default";
  if (typeof imageSize === "string") return imageSize;
  return `${imageSize.width}x${imageSize.height}`;
}

function fixtureKey(modelId: string, body: FalRequestBody): string {
  const hash = createHash("sha256")
    .update(`${modelId}:${body.prompt}:${imageSizeKey(body.image_size)}:${body.seed ?? "none"}`)
    .digest("hex")
    .slice(0, 12);
  const slug = modelId.replace(/\//g, "-");
  return `${slug}-${hash}`;
}

function extFromMediaType(mediaType: string | undefined): string {
  if (!mediaType) return "jpg";
  if (mediaType.includes("png")) return "png";
  if (mediaType.includes("webp")) return "webp";
  return "jpg";
}

function mediaTypeFromFile(file: string): string {
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function inputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function inputMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

// --- Handlers ---

async function handleFalPost(
  url: string,
  init: RequestInit | undefined,
  opts: FalMockOptions,
): Promise<Response> {
  const modelId = new URL(url).pathname.replace(/^\//, "");

  // The fal SDK always sends a JSON string body. Other BodyInit shapes
  // (Blob, FormData, ReadableStream, Uint8Array) would require a different
  // decode path — fail loudly rather than silently mis-parsing.
  if (typeof init?.body !== "string") {
    return new Response(
      `fal-mock: expected string body, got ${typeof init?.body} (${init?.body?.constructor?.name ?? "none"})`,
      { status: 500 },
    );
  }
  const body = JSON.parse(init.body) as FalRequestBody;
  const key = fixtureKey(modelId, body);

  if (opts.mode === "replay") {
    const jsonPath = join(opts.fixturePath, `${key}.json`);
    try {
      const content = await readFile(jsonPath, "utf-8");
      return new Response(content, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      return new Response(
        `fal-mock: no fixture for key "${key}" (model=${modelId} prompt="${body.prompt.slice(0, 60)}...")`,
        { status: 503, headers: { "Content-Type": "text/plain" } },
      );
    }
  }

  // record mode: passthrough + capture
  const realResp = await globalThis.fetch(url, init);
  if (!realResp.ok) {
    return realResp;
  }
  const falJson = (await realResp.json()) as FalResponse;

  await mkdir(opts.fixturePath, { recursive: true });

  // fal sometimes returns 200 with an error object in the body (rate limits,
  // content-policy rejections, etc.). Surface this as 502 rather than
  // writing a malformed fixture.
  if (!Array.isArray(falJson.images) || falJson.images.length === 0) {
    return new Response(
      `fal-mock: real fal response had no images: ${JSON.stringify(falJson).slice(0, 200)}`,
      { status: 502 },
    );
  }
  const origImg = falJson.images[0];
  if (!origImg) {
    return new Response("fal-mock: real fal response had no images", { status: 502 });
  }
  const ext = extFromMediaType(origImg.content_type);
  const imgFileName = `${key}.${ext}`;

  // Download the real CDN image + write to disk.
  const imgBytesResp = await globalThis.fetch(origImg.url);
  if (!imgBytesResp.ok) {
    return new Response(`fal-mock: real CDN returned ${imgBytesResp.status}`, {
      status: imgBytesResp.status,
    });
  }
  const imgBytes = Buffer.from(await imgBytesResp.arrayBuffer());
  await writeFile(join(opts.fixturePath, imgFileName), imgBytes);

  // Rewrite URL in response so the SDK's follow-up download hits our mock CDN.
  const rewritten: FalResponse = {
    ...falJson,
    images: falJson.images.map((img, i) =>
      i === 0 ? { ...img, url: `${MOCK_CDN_HOST}/${imgFileName}` } : img,
    ),
  };
  await writeFile(join(opts.fixturePath, `${key}.json`), JSON.stringify(rewritten, null, 2));

  return new Response(JSON.stringify(rewritten), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleCdnGet(url: string, opts: FalMockOptions): Promise<Response> {
  const file = new URL(url).pathname.replace(/^\//, "");
  try {
    const bytes = await readFile(join(opts.fixturePath, file));
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "Content-Type": mediaTypeFromFile(file) },
    });
  } catch {
    return new Response(`fal-mock: no image "${file}"`, { status: 503 });
  }
}

// --- Public API ---

export interface FalMockOptions {
  mode: "replay" | "record";
  fixturePath: string;
}

/**
 * Create a `fetch`-compatible function that intercepts fal.ai traffic
 * (both the API and our mock CDN) and delegates everything else to
 * `globalThis.fetch`. Pass the result to `createFal({ fetch })`.
 *
 * Unmatched fal-shaped URLs (other than the two we handle) return 503 in
 * replay mode for strict-mode guarantees. In record mode, they pass through
 * to the real network.
 */
export function createFalFetch(
  opts: FalMockOptions,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = inputUrl(input);
    const method = inputMethod(input, init);

    if (url.startsWith(`${FAL_HOST}/`) && method === "POST") {
      return handleFalPost(url, init, opts);
    }
    if (url.startsWith(`${MOCK_CDN_HOST}/`) && method === "GET") {
      return handleCdnGet(url, opts);
    }

    // Strict replay: any other fal-host URL is unexpected.
    if (opts.mode === "replay" && (url.includes("fal.run") || url.includes("fal.media"))) {
      return new Response(`fal-mock: unexpected ${method} ${url}`, { status: 503 });
    }

    // Fallback (shouldn't happen in practice — the custom fetch is only wired
    // into the fal provider, which only calls fal/CDN URLs).
    return globalThis.fetch(input, init);
  };
}
