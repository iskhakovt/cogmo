import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenAIVoiceFetch } from "./openai-voice-mock.js";

let fixtureDir: string;

beforeEach(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "voice-mock-"));
});

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe("createOpenAIVoiceFetch", () => {
  it("returns the committed audio fixture for a TTS call (replay match)", async () => {
    const audio = Buffer.from("OggS\0\0\0\0\0\0\0\0\0\0fake-ogg-bytes");
    // Same key derivation as the impl: tts-{model}-{voice}-{sha256(text):12}
    const { createHash } = await import("node:crypto");
    const text = "hello there";
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);
    const key = `tts-gpt-4o-mini-tts-alloy-${hash}`;
    await writeFile(join(fixtureDir, `${key}.ogg`), audio);

    const fetch = createOpenAIVoiceFetch({ mode: "replay", fixturePath: fixtureDir });
    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: text,
        response_format: "opus",
      }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("audio/ogg");
    const bytes = Buffer.from(await resp.arrayBuffer());
    expect(bytes.equals(audio)).toBe(true);
  });

  it("returns 503 in replay mode when no TTS fixture matches", async () => {
    const fetch = createOpenAIVoiceFetch({ mode: "replay", fixturePath: fixtureDir });
    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: "unknown" }),
    });
    expect(resp.status).toBe(503);
    const body = await resp.text();
    expect(body).toMatch(/no TTS fixture/);
  });

  it("returns the committed JSON for an STT call (replay match by audio bytes hash)", async () => {
    const audio = new Uint8Array([1, 2, 3, 4, 5]);
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(audio).digest("hex").slice(0, 12);
    const key = `stt-gpt-4o-mini-transcribe-${hash}`;
    await writeFile(join(fixtureDir, `${key}.json`), JSON.stringify({ text: "transcribed text" }));

    const fd = new FormData();
    fd.set("model", "gpt-4o-mini-transcribe");
    fd.set("file", new Blob([audio], { type: "audio/ogg" }), "audio.ogg");

    const fetch = createOpenAIVoiceFetch({ mode: "replay", fixturePath: fixtureDir });
    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      body: fd,
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { text: string };
    expect(json.text).toBe("transcribed text");
  });

  it("returns 503 in replay mode when no STT fixture matches", async () => {
    const fd = new FormData();
    fd.set("model", "gpt-4o-mini-transcribe");
    fd.set("file", new Blob([new Uint8Array([9, 9, 9])], { type: "audio/ogg" }), "audio.ogg");

    const fetch = createOpenAIVoiceFetch({ mode: "replay", fixturePath: fixtureDir });
    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      body: fd,
    });
    expect(resp.status).toBe(503);
    const body = await resp.text();
    expect(body).toMatch(/no STT fixture/);
  });

  it("returns 503 in replay mode for unrecognized OpenAI audio paths", async () => {
    const fetch = createOpenAIVoiceFetch({ mode: "replay", fixturePath: fixtureDir });
    const resp = await fetch("https://api.openai.com/v1/audio/realtime", { method: "POST" });
    expect(resp.status).toBe(503);
  });

  it("delegates non-OpenAI URLs to globalThis.fetch in replay mode", async () => {
    const fetch = createOpenAIVoiceFetch({ mode: "replay", fixturePath: fixtureDir });
    // Use a clearly invalid host so the delegated call surfaces as a network
    // error — the assertion is only that we got past the interceptor's
    // guards, not that the request succeeded.
    await expect(fetch("http://127.0.0.1:1/unrelated", { method: "GET" })).rejects.toThrow();
  });

  it("derives different fixture keys for different voices", async () => {
    const audio = Buffer.from("v1");
    const audio2 = Buffer.from("v2");
    const { createHash } = await import("node:crypto");
    const text = "same text";
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(join(fixtureDir, `tts-gpt-4o-mini-tts-alloy-${hash}.ogg`), audio);
    await writeFile(join(fixtureDir, `tts-gpt-4o-mini-tts-shimmer-${hash}.ogg`), audio2);

    const fetch = createOpenAIVoiceFetch({ mode: "replay", fixturePath: fixtureDir });
    const r1 = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: text,
        response_format: "opus",
      }),
    });
    const r2 = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "shimmer",
        input: text,
        response_format: "opus",
      }),
    });
    expect(Buffer.from(await r1.arrayBuffer()).toString()).toBe("v1");
    expect(Buffer.from(await r2.arrayBuffer()).toString()).toBe("v2");
  });

  it("rejects TTS with a non-string body in replay mode", async () => {
    const fetch = createOpenAIVoiceFetch({ mode: "replay", fixturePath: fixtureDir });
    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid body type
      body: new Blob(["x"]) as any,
    });
    expect(resp.status).toBe(500);
    expect(await resp.text()).toMatch(/expected JSON string body/);
  });

  it("matches the same audio bytes regardless of how the FormData is constructed", async () => {
    const audio = new Uint8Array([10, 20, 30]);
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(audio).digest("hex").slice(0, 12);
    const key = `stt-whisper-1-${hash}`;
    await writeFile(join(fixtureDir, `${key}.json`), JSON.stringify({ text: "ok" }));

    const fetch = createOpenAIVoiceFetch({ mode: "replay", fixturePath: fixtureDir });

    const fd1 = new FormData();
    fd1.set("model", "whisper-1");
    fd1.set("file", new Blob([audio], { type: "audio/ogg" }), "a.ogg");
    const r1 = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      body: fd1,
    });
    expect(r1.status).toBe(200);

    // Re-issue with a fresh FormData built from the same bytes — must hit the same fixture.
    const fd2 = new FormData();
    fd2.set("model", "whisper-1");
    fd2.set("file", new Blob([Buffer.from(audio)], { type: "audio/ogg" }), "different-name.ogg");
    const r2 = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      body: fd2,
    });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { text: string }).text).toBe("ok");
  });

  it("audio bytes hash is bytes-sensitive (different bytes → no match)", async () => {
    const audio = new Uint8Array([1, 2, 3]);
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(audio).digest("hex").slice(0, 12);
    const key = `stt-m-${hash}`;
    await writeFile(join(fixtureDir, `${key}.json`), JSON.stringify({ text: "ok" }));

    const fd = new FormData();
    fd.set("model", "m");
    // One byte different → different hash → no fixture.
    fd.set("file", new Blob([new Uint8Array([1, 2, 4])], { type: "audio/ogg" }), "a.ogg");
    const fetch = createOpenAIVoiceFetch({ mode: "replay", fixturePath: fixtureDir });
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      body: fd,
    });
    expect(r.status).toBe(503);
  });
});
