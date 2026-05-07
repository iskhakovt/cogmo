/**
 * Scoped `fetch` interceptor for OpenAI voice traffic — record/replay for
 * integration tests.
 *
 * llmock (`@copilotkit/aimock`) speaks Anthropic Messages and OpenAI
 * chat/completions + embeddings, but not `/v1/audio/speech` or
 * `/v1/audio/transcriptions`. This module fills the gap with the same
 * pattern as `fal-mock.ts`: a fetch wrapper passed to the OpenAI SDK
 * (`new OpenAI({ fetch })`) that intercepts only the audio endpoints.
 *
 * Strategy:
 * - Intercept `POST https://api.openai.com/v1/audio/speech` (TTS).
 * - Intercept `POST https://api.openai.com/v1/audio/transcriptions` (STT).
 * - Anything else falls through to `globalThis.fetch` so a single client
 *   could in principle hit both `/v1/audio/*` and `/v1/chat/completions`
 *   without mis-routing (the OpenAI voice provider is dedicated, but
 *   keeping the fallback honest avoids surprises).
 *
 * Modes:
 * - **replay** (default, CI): loads `{key}.{ext}` from disk for TTS audio
 *   and `{key}.json` for STT responses. Unmatched audio-endpoint traffic
 *   returns 503 (strict, like llmock and fal-mock).
 * - **record** (local, `RECORD=1 OPENAI_API_KEY=sk-...`): passes through
 *   to real OpenAI, captures the response (audio bytes for TTS, JSON for
 *   STT), writes the fixture, and returns the same response to the SDK.
 *
 * Fixture keys:
 * - TTS: `tts-{model}-{voice}-{sha256(text):12}.{ogg|mp3}` + `.json` sidecar
 *   recording the response media type.
 * - STT: `stt-{model}-{sha256(audio_bytes):12}.json` carrying the
 *   transcription response verbatim.
 *
 * Hashing the audio bytes (rather than the input text the test logically
 * sends) is necessary because STT receives only bytes — a deterministic
 * test must feed the same bytes every run, and the cheapest way to get
 * deterministic bytes is to commit the inbound fixture clip alongside the
 * STT response. The integration test reads the clip from disk and feeds
 * those exact bytes through the pipeline.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OPENAI_HOST = "https://api.openai.com";
const TTS_PATH = "/v1/audio/speech";
const STT_PATH = "/v1/audio/transcriptions";

interface TtsRequestBody {
  model: string;
  voice: string;
  input: string;
  response_format?: "opus" | "mp3" | "aac" | "flac" | "wav" | "pcm";
}

interface TtsFixtureMeta {
  mediaType: string;
  responseFormat: string;
}

interface SttResponseBody {
  text: string;
  language?: string;
}

function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function ttsFixtureKey(body: TtsRequestBody): string {
  const hash = sha256Hex(body.input).slice(0, 12);
  return `tts-${body.model}-${body.voice}-${hash}`;
}

function sttFixtureKey(model: string, audio: Uint8Array): string {
  const hash = sha256Hex(audio).slice(0, 12);
  return `stt-${model}-${hash}`;
}

function extFromResponseFormat(fmt: string | undefined): string {
  if (!fmt || fmt === "opus") return "ogg";
  if (fmt === "mp3") return "mp3";
  if (fmt === "wav") return "wav";
  if (fmt === "flac") return "flac";
  return fmt;
}

function mediaTypeForExt(ext: string): string {
  if (ext === "ogg") return "audio/ogg";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "wav") return "audio/wav";
  if (ext === "flac") return "audio/flac";
  return "application/octet-stream";
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

// --- TTS ---

async function readTtsBody(init: RequestInit | undefined): Promise<TtsRequestBody> {
  if (typeof init?.body !== "string") {
    throw new Error(
      `openai-voice-mock: expected JSON string body for TTS, got ${typeof init?.body} (${init?.body?.constructor?.name ?? "none"})`,
    );
  }
  return JSON.parse(init.body) as TtsRequestBody;
}

async function handleTts(
  url: string,
  init: RequestInit | undefined,
  opts: OpenAIVoiceMockOptions,
): Promise<Response> {
  let body: TtsRequestBody;
  try {
    body = await readTtsBody(init);
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "openai-voice-mock: bad TTS body", {
      status: 500,
    });
  }

  const responseFormat = body.response_format ?? "mp3";
  const ext = extFromResponseFormat(responseFormat);
  const mediaType = mediaTypeForExt(ext);
  const key = ttsFixtureKey(body);

  if (opts.mode === "replay") {
    const audioPath = join(opts.fixturePath, `${key}.${ext}`);
    try {
      const audio = await readFile(audioPath);
      return new Response(new Uint8Array(audio), {
        status: 200,
        headers: { "Content-Type": mediaType },
      });
    } catch {
      return new Response(
        `openai-voice-mock: no TTS fixture for key "${key}" (model=${body.model} voice=${body.voice} text="${body.input.slice(0, 60)}")`,
        { status: 503, headers: { "Content-Type": "text/plain" } },
      );
    }
  }

  // record mode: passthrough + capture
  const realResp = await globalThis.fetch(url, init);
  if (!realResp.ok) return realResp;

  const audio = Buffer.from(await realResp.arrayBuffer());
  await mkdir(opts.fixturePath, { recursive: true });
  await writeFile(join(opts.fixturePath, `${key}.${ext}`), audio);
  const meta: TtsFixtureMeta = { mediaType, responseFormat };
  await writeFile(join(opts.fixturePath, `${key}.json`), JSON.stringify(meta, null, 2));

  return new Response(new Uint8Array(audio), {
    status: 200,
    headers: { "Content-Type": mediaType },
  });
}

// --- STT ---

async function readSttMultipart(
  init: RequestInit | undefined,
): Promise<{ model: string; audio: Uint8Array }> {
  // The OpenAI SDK builds STT requests as `multipart/form-data` with
  // `file` (the audio Blob/File) and `model` (string) parts. The Node
  // fetch layer hands us the body as either a FormData instance or a
  // ReadableStream of multipart bytes — handle both.
  if (init?.body instanceof FormData) {
    const fd = init.body;
    const model = String(fd.get("model") ?? "");
    const file = fd.get("file");
    if (!model || !(file instanceof Blob)) {
      throw new Error("openai-voice-mock: STT FormData missing model or file");
    }
    const audio = new Uint8Array(await file.arrayBuffer());
    return { model, audio };
  }
  // Fallback: reconstruct from a Request and let it parse formData for us.
  // This covers the path where the SDK passes a ReadableStream body.
  if (init?.body instanceof ReadableStream) {
    const reqHeaders = new Headers(init.headers);
    if (!reqHeaders.has("Content-Type")) {
      throw new Error(
        "openai-voice-mock: STT body is a ReadableStream but request has no Content-Type header",
      );
    }
    const reconstituted = new Request("https://placeholder.invalid", {
      method: "POST",
      headers: reqHeaders,
      body: init.body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const fd = await reconstituted.formData();
    const model = String(fd.get("model") ?? "");
    const file = fd.get("file");
    if (!model || !(file instanceof Blob)) {
      throw new Error("openai-voice-mock: STT FormData (reconstructed) missing model or file");
    }
    const audio = new Uint8Array(await file.arrayBuffer());
    return { model, audio };
  }
  throw new Error(
    `openai-voice-mock: STT body is not FormData or ReadableStream (got ${init?.body?.constructor?.name ?? "none"})`,
  );
}

async function handleStt(
  url: string,
  init: RequestInit | undefined,
  opts: OpenAIVoiceMockOptions,
): Promise<Response> {
  let parsed: { model: string; audio: Uint8Array };
  try {
    parsed = await readSttMultipart(init);
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "openai-voice-mock: bad STT body", {
      status: 500,
    });
  }

  const key = sttFixtureKey(parsed.model, parsed.audio);

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
        `openai-voice-mock: no STT fixture for key "${key}" (model=${parsed.model} audio_bytes=${parsed.audio.byteLength})`,
        { status: 503, headers: { "Content-Type": "text/plain" } },
      );
    }
  }

  // record mode: re-issue the request — the original `init.body` may have
  // already been consumed during multipart parsing, so build a fresh
  // FormData from the parsed parts.
  const recordFd = new FormData();
  recordFd.set("model", parsed.model);
  // Wrap the bytes as a Buffer so Blob's BodyInit accepts them — Uint8Array
  // typings rejected here under Node 22's lib.dom.
  recordFd.set("file", new Blob([Buffer.from(parsed.audio)], { type: "audio/ogg" }), "audio.ogg");
  // Preserve any non-Content-Type headers (Authorization, etc.). Drop
  // Content-Type so fetch generates a fresh multipart boundary.
  const recordHeaders = new Headers(init?.headers);
  recordHeaders.delete("Content-Type");
  const realResp = await globalThis.fetch(url, {
    method: "POST",
    headers: recordHeaders,
    body: recordFd,
  });
  if (!realResp.ok) return realResp;

  const text = await realResp.text();
  await mkdir(opts.fixturePath, { recursive: true });
  // Re-serialize through JSON.parse to normalise whitespace before commit.
  const parsedBody = JSON.parse(text) as SttResponseBody;
  await writeFile(join(opts.fixturePath, `${key}.json`), JSON.stringify(parsedBody, null, 2));

  return new Response(JSON.stringify(parsedBody), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Public API ---

export interface OpenAIVoiceMockOptions {
  mode: "replay" | "record";
  fixturePath: string;
}

/**
 * Create a `fetch`-compatible function that intercepts OpenAI voice
 * endpoints (`/v1/audio/speech`, `/v1/audio/transcriptions`) and delegates
 * everything else to `globalThis.fetch`. Pass the result to
 * `new OpenAI({ fetch })` (which the project surfaces via
 * `OpenAIVoiceConfig.fetch`).
 *
 * Unmatched OpenAI-host audio URLs return 503 in replay mode (strict).
 * In record mode, anything we don't recognise falls through to the real
 * network so a future endpoint addition doesn't silently no-op.
 */
export function createOpenAIVoiceFetch(
  opts: OpenAIVoiceMockOptions,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = inputUrl(input);
    const method = inputMethod(input, init);

    if (method === "POST" && url.startsWith(`${OPENAI_HOST}${TTS_PATH}`)) {
      return handleTts(url, init, opts);
    }
    if (method === "POST" && url.startsWith(`${OPENAI_HOST}${STT_PATH}`)) {
      return handleStt(url, init, opts);
    }

    if (opts.mode === "replay" && url.startsWith(`${OPENAI_HOST}/v1/audio/`)) {
      return new Response(`openai-voice-mock: unexpected ${method} ${url}`, { status: 503 });
    }

    return globalThis.fetch(input, init);
  };
}
