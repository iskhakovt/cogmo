/**
 * Scoped `fetch` interceptor for Venice.ai's native `/image/generate` endpoint —
 * record/replay for integration tests.
 *
 * Mirrors `src/test/fal-mock.ts`: llmock can't cover Venice's bespoke wire
 * shape (response-header censorship signals, base64 image bytes inline) so
 * this module fills the gap with a fetch wrapper scoped to Venice's host.
 *
 * Why a custom fetch, not MSW: same reasoning as fal-mock. Per-library fetch
 * injection (`VeniceImageProvider({ fetch })`) is strictly scoped to Venice —
 * Anthropic via llmock, Hindsight, MinIO are untouched.
 *
 * Strategy:
 * - Intercept `POST {VENICE_HOST}/api/v1/image/generate`.
 * - On replay, load `{key}.json` from disk and replay the recorded
 *   status/headers/body (so `x-venice-is-content-violation` and
 *   `x-venice-is-blurred` survive across the wire).
 *
 * Modes:
 * - **replay** (default, CI): unmatched requests return 503 with a
 *   re-record hint (same posture as fal-mock / daytona-mock).
 * - **record** (local, `RECORD=1 VENICE_INFERENCE_KEY=...`): passes through
 *   to real Venice, captures the response (headers + body), writes the
 *   fixture, and returns the response to the caller. Replay-ready
 *   immediately.
 *
 * Fixture key: `venice-{sha256(model:prompt:safe_mode:negative_prompt):12}`.
 * Body comparison is intentionally loose — fixture matching is `(method,
 * model, prompt)` after the hash; per-call randomness in non-keyed fields
 * (seed, aspect_ratio) doesn't churn fixtures.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const VENICE_HOST = "https://api.venice.ai";
const VENICE_GENERATE_PATH = "/api/v1/image/generate";

interface VeniceRequestBodyLike {
  model: string;
  prompt: string;
  safe_mode?: boolean;
  negative_prompt?: string;
}

interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function fixtureKey(body: VeniceRequestBodyLike): string {
  const hash = createHash("sha256")
    .update(
      [
        body.model,
        body.prompt,
        body.safe_mode === undefined ? "default" : String(body.safe_mode),
        body.negative_prompt ?? "",
      ].join(":"),
    )
    .digest("hex")
    .slice(0, 12);
  const slug = body.model.replace(/[^a-z0-9]/gi, "-");
  return `venice-${slug}-${hash}`;
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

async function handleGenerate(
  init: RequestInit | undefined,
  opts: VeniceMockOptions,
): Promise<Response> {
  if (typeof init?.body !== "string") {
    return new Response(`venice-mock: expected string body, got ${typeof init?.body}`, {
      status: 500,
    });
  }
  const body = JSON.parse(init.body) as VeniceRequestBodyLike;
  const key = fixtureKey(body);
  const jsonPath = join(opts.fixturePath, `${key}.json`);

  if (opts.mode === "replay") {
    try {
      const content = await readFile(jsonPath, "utf-8");
      const recorded = JSON.parse(content) as RecordedResponse;
      return new Response(JSON.stringify(recorded.body), {
        status: recorded.status,
        headers: recorded.headers,
      });
    } catch {
      return new Response(
        `venice-mock: no fixture for key "${key}" (model=${body.model} prompt="${body.prompt.slice(0, 60)}..."). ` +
          "Re-record with RECORD=1 VENICE_INFERENCE_KEY=... pnpm test:record.",
        { status: 503, headers: { "Content-Type": "text/plain" } },
      );
    }
  }

  // record mode: passthrough + capture
  const realResp = await globalThis.fetch(`${VENICE_HOST}${VENICE_GENERATE_PATH}`, init);
  const responseBody = await realResp.text();
  // Build a headers map filtering down to what consumers care about — we
  // explicitly preserve the censorship headers, content-type, and the
  // status. Don't capture cookies, set-cookie, ratelimit-reset, etc.
  const captured: RecordedResponse = {
    status: realResp.status,
    headers: {
      "Content-Type": realResp.headers.get("Content-Type") ?? "application/json",
      ...(realResp.headers.get("x-venice-is-blurred") !== null && {
        "x-venice-is-blurred": realResp.headers.get("x-venice-is-blurred") ?? "",
      }),
      ...(realResp.headers.get("x-venice-is-content-violation") !== null && {
        "x-venice-is-content-violation":
          realResp.headers.get("x-venice-is-content-violation") ?? "",
      }),
    },
    body: tryParseJson(responseBody),
  };

  await mkdir(opts.fixturePath, { recursive: true });
  await writeFile(jsonPath, JSON.stringify(captured, null, 2));

  return new Response(JSON.stringify(captured.body), {
    status: captured.status,
    headers: captured.headers,
  });
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export interface VeniceMockOptions {
  mode: "replay" | "record";
  fixturePath: string;
}

/**
 * Create a `fetch`-compatible function that intercepts Venice's native
 * `/image/generate` endpoint and delegates everything else to
 * `globalThis.fetch`. Pass the result to `VeniceImageProvider({ fetch })`.
 */
export function createVeniceFetch(
  opts: VeniceMockOptions,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = inputUrl(input);
    const method = inputMethod(input, init);

    if (url.startsWith(`${VENICE_HOST}${VENICE_GENERATE_PATH}`) && method === "POST") {
      return handleGenerate(init, opts);
    }

    if (opts.mode === "replay" && url.includes("venice.ai")) {
      return new Response(`venice-mock: unexpected ${method} ${url}`, { status: 503 });
    }

    return globalThis.fetch(input, init);
  };
}
