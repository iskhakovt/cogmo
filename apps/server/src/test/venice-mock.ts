/**
 * Scoped `fetch` interceptor for Venice.ai's native `/image/generate` endpoint
 * and the `/models` listing the adapter sizes requests from — record/replay
 * for integration tests.
 *
 * Mirrors `src/test/fal-mock.ts`: llmock can't cover Venice's bespoke wire
 * shape (response-header content-policy signals, base64 image bytes inline) so
 * this module fills the gap with a fetch wrapper scoped to Venice's host.
 *
 * Why a custom fetch, not MSW: same reasoning as fal-mock. Per-library fetch
 * injection (`VeniceImageProvider({ fetch })`) is strictly scoped to Venice —
 * Anthropic via llmock, Hindsight, RustFS are untouched.
 *
 * Strategy:
 * - Intercept `POST {VENICE_HOST}/api/v1/image/generate`.
 * - Intercept `GET {VENICE_HOST}/api/v1/models?type=…`, one fixture per
 *   `type` (`venice-models-{type}.json`). A fresh recording captures the
 *   whole catalog; trim it to the models the tests use before committing.
 * - On replay, load `{key}.json` from disk and replay the recorded
 *   status/headers/body (so `x-venice-is-content-violation` and
 *   `x-venice-is-blurred` survive across the wire).
 *
 * Modes:
 * - **replay** (default, CI): unmatched requests return 503 with a
 *   re-record hint (same posture as fal-mock / daytona-mock).
 * - **record** (local, `RECORD=1 VENICE_API_KEY=...`): passes through
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
const VENICE_MODELS_PATH = "/api/v1/models";

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

/**
 * Fixture key — what makes "the same request" the same recording.
 *
 * Includes: model, prompt, safe_mode, negative_prompt — fields whose
 * variation produces a meaningfully different upstream response.
 *
 * Excludes: aspect_ratio, seed, width/height. Changing the ratio in a
 * test does NOT re-trigger record mode and does NOT fail replay — the
 * recorded image is whatever ratio was captured the day of recording,
 * and stubbed payloads ignore the ratio anyway. If a future test
 * widens coverage to assert response dimensions, add the ratio to this
 * key so divergent recordings get separate files.
 */
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
          "Re-record with RECORD=1 VENICE_API_KEY=... pnpm test:record.",
        { status: 503, headers: { "Content-Type": "text/plain" } },
      );
    }
  }

  // record mode: passthrough + capture.
  //
  // `globalThis.fetch` deliberately bypasses any per-test fetch override
  // the harness wired up (e.g. an integration test that scopes a
  // `createVeniceFetch` to the adapter). Record mode wants to hit the
  // real Venice API directly — if it went through the test's own
  // override we'd be capturing the override's response, not Venice's.
  // A consequence: if the host environment has a transparent HTTP
  // proxy (corporate CI runner), recordings would capture the proxy's
  // response. Run `RECORD=1` from a machine on a clean network.
  const realResp = await globalThis.fetch(`${VENICE_HOST}${VENICE_GENERATE_PATH}`, init);
  const responseBody = await realResp.text();
  // Build a headers map filtering down to what consumers care about — we
  // explicitly preserve the content-policy headers, content-type, and the
  // status. Don't capture cookies, set-cookie, ratelimit-reset, etc.
  const blurredHeader = realResp.headers.get("x-venice-is-blurred");
  const violationHeader = realResp.headers.get("x-venice-is-content-violation");
  const captured: RecordedResponse = {
    status: realResp.status,
    headers: {
      "Content-Type": realResp.headers.get("Content-Type") ?? "application/json",
      ...(blurredHeader !== null && { "x-venice-is-blurred": blurredHeader }),
      ...(violationHeader !== null && { "x-venice-is-content-violation": violationHeader }),
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

/**
 * Replay or record the models listing. Keyed on the `type` query parameter
 * alone — the listing is the same for every caller and changes only when
 * Venice changes its catalog.
 */
async function handleModels(
  url: string,
  init: RequestInit | undefined,
  opts: VeniceMockOptions,
): Promise<Response> {
  const type = new URL(url).searchParams.get("type") ?? "all";
  const jsonPath = join(opts.fixturePath, `venice-models-${type}.json`);

  if (opts.mode === "replay") {
    try {
      const recorded = JSON.parse(await readFile(jsonPath, "utf-8")) as RecordedResponse;
      return new Response(JSON.stringify(recorded.body), {
        status: recorded.status,
        headers: recorded.headers,
      });
    } catch {
      return new Response(
        `venice-mock: no fixture for the models listing (type=${type}). ` +
          "Re-record with RECORD=1 VENICE_API_KEY=... pnpm test:record.",
        { status: 503, headers: { "Content-Type": "text/plain" } },
      );
    }
  }

  // Record mode: same direct-to-Venice passthrough as `handleGenerate`.
  const realResp = await globalThis.fetch(url, init);
  const captured: RecordedResponse = {
    status: realResp.status,
    headers: {
      "Content-Type": realResp.headers.get("Content-Type") ?? "application/json",
    },
    body: tryParseJson(await realResp.text()),
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
 * `/image/generate` endpoint and its `/models` listing, and delegates
 * everything else to `globalThis.fetch`. Pass the result to
 * `VeniceImageProvider({ fetch })`.
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

    if (url.startsWith(`${VENICE_HOST}${VENICE_MODELS_PATH}`) && method === "GET") {
      return handleModels(url, init, opts);
    }

    if (opts.mode === "replay" && url.includes("venice.ai")) {
      return new Response(`venice-mock: unexpected ${method} ${url}`, { status: 503 });
    }

    return globalThis.fetch(input, init);
  };
}
