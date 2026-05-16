import { describe, expect, it, vi } from "vitest";
import { ElevenLabsTtsProvider } from "./elevenlabs.js";

function audioResponse(bytes: Uint8Array, init: { status?: number } = {}) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    statusText: "OK",
    arrayBuffer: async () => buffer,
    text: async () => "",
  } as Response;
}

function errorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    statusText: "Error",
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => body,
  } as Response;
}

describe("ElevenLabsTtsProvider", () => {
  it("posts OGG/Opus by default and returns audio/ogg", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(audioResponse(new Uint8Array([1, 2, 3])));
    const provider = new ElevenLabsTtsProvider({ apiKey: "xi-secret", fetch: fetchMock });

    const result = await provider.tts({ text: "hello", voice: "voice-id-1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice-id-1?output_format=opus_48000_128",
    );
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("xi-secret");
    expect(headers.accept).toBe("audio/ogg");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({
      text: "hello",
      model_id: "eleven_turbo_v2_5",
    });
    expect(result.audio).toEqual(Buffer.from([1, 2, 3]));
    expect(result.mediaType).toBe("audio/ogg");
  });

  it("respects an explicit model override", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(audioResponse(new Uint8Array([])));
    const provider = new ElevenLabsTtsProvider({ apiKey: "k", fetch: fetchMock });

    await provider.tts({ text: "hi", voice: "v", model: "eleven_multilingual_v2" });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string) as {
      text: string;
      model_id: string;
    };
    expect(body.model_id).toBe("eleven_multilingual_v2");
  });

  it("falls back to a default voice when caller provides empty string", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(audioResponse(new Uint8Array([])));
    const provider = new ElevenLabsTtsProvider({ apiKey: "k", fetch: fetchMock });

    await provider.tts({ text: "hi", voice: "" });

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?");
  });

  it("emits MP3 when format=mp3 requested", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(audioResponse(new Uint8Array([0xff, 0xfb, 0x90])));
    const provider = new ElevenLabsTtsProvider({ apiKey: "k", fetch: fetchMock });

    const result = await provider.tts({ text: "hi", voice: "v", format: "mp3" });

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("output_format=mp3_44100_128");
    const headers = fetchMock.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers.accept).toBe("audio/mpeg");
    expect(result.mediaType).toBe("audio/mpeg");
  });

  it("honors a custom baseURL and strips trailing slashes", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(audioResponse(new Uint8Array([])));
    const provider = new ElevenLabsTtsProvider({
      apiKey: "k",
      baseURL: "https://relay.example.com//",
      fetch: fetchMock,
    });

    await provider.tts({ text: "hi", voice: "v" });

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url.startsWith("https://relay.example.com/v1/text-to-speech/v?")).toBe(true);
  });

  it("URL-encodes the voice id so a slash in the id stays in the path segment", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(audioResponse(new Uint8Array([])));
    const provider = new ElevenLabsTtsProvider({ apiKey: "k", fetch: fetchMock });

    await provider.tts({ text: "hi", voice: "weird/id" });

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/v1/text-to-speech/weird%2Fid?");
  });

  it("throws with the upstream body when fetch returns a non-2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(errorResponse(401, '{"detail":"bad key"}'));
    const provider = new ElevenLabsTtsProvider({ apiKey: "k", fetch: fetchMock });

    await expect(provider.tts({ text: "hi", voice: "v" })).rejects.toThrow(
      /ElevenLabs TTS failed \(401\).*bad key/,
    );
  });
});
