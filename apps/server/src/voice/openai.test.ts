import { describe, expect, it, vi } from "vitest";
import { OpenAIVoiceProvider } from "./openai.js";

// Mock the OpenAI SDK — class so `new OpenAI()` works, plus a `toFile`
// helper that captures input shape without touching the filesystem.
const mockSpeechCreate = vi.fn();
const mockTranscriptionsCreate = vi.fn();
const mockToFile = vi.fn();

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      audio = {
        speech: { create: mockSpeechCreate },
        transcriptions: { create: mockTranscriptionsCreate },
      };
    },
    toFile: (...args: unknown[]) => mockToFile(...args),
  };
});

function createProvider() {
  mockSpeechCreate.mockReset();
  mockTranscriptionsCreate.mockReset();
  mockToFile.mockReset();
  // Default toFile passthrough — captures what was called and returns a sentinel.
  mockToFile.mockImplementation(async (buffer, filename, options) => ({
    __sentinel: "uploadable",
    buffer,
    filename,
    options,
  }));
  return new OpenAIVoiceProvider({ apiKey: "test-key" });
}

// Build a fake `Response`-shaped object — the SDK's `speech.create` returns
// a Web Response. Only `arrayBuffer()` is consumed by the provider.
function audioResponse(bytes: Uint8Array) {
  return {
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

describe("OpenAIVoiceProvider — TTS", () => {
  it("synthesizes via opus by default and returns audio/ogg", async () => {
    const provider = createProvider();
    mockSpeechCreate.mockResolvedValueOnce(audioResponse(new Uint8Array([1, 2, 3, 4])));

    const result = await provider.tts({ text: "hello", voice: "alloy" });

    const callArgs = mockSpeechCreate.mock.calls[0]![0];
    expect(callArgs.input).toBe("hello");
    expect(callArgs.voice).toBe("alloy");
    expect(callArgs.response_format).toBe("opus");
    // Default model when none supplied.
    expect(callArgs.model).toBe("gpt-4o-mini-tts");

    expect(result.audio).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(result.mediaType).toBe("audio/ogg");
  });

  it("respects an explicit model override", async () => {
    const provider = createProvider();
    mockSpeechCreate.mockResolvedValueOnce(audioResponse(new Uint8Array([])));

    await provider.tts({ text: "hi", voice: "nova", model: "tts-1-hd" });

    expect(mockSpeechCreate.mock.calls[0]![0].model).toBe("tts-1-hd");
  });

  it("falls back to a default voice when caller provides empty string", async () => {
    const provider = createProvider();
    mockSpeechCreate.mockResolvedValueOnce(audioResponse(new Uint8Array([])));

    await provider.tts({ text: "hi", voice: "" });

    expect(mockSpeechCreate.mock.calls[0]![0].voice).toBe("alloy");
  });

  it("emits MP3 when format=mp3 requested", async () => {
    const provider = createProvider();
    mockSpeechCreate.mockResolvedValueOnce(audioResponse(new Uint8Array([0xff, 0xfb])));

    const result = await provider.tts({ text: "hi", voice: "alloy", format: "mp3" });

    expect(mockSpeechCreate.mock.calls[0]![0].response_format).toBe("mp3");
    expect(result.mediaType).toBe("audio/mpeg");
  });

  it("propagates SDK errors verbatim (no swallowing)", async () => {
    const provider = createProvider();
    const err = new Error("403 Forbidden");
    mockSpeechCreate.mockRejectedValueOnce(err);

    await expect(provider.tts({ text: "hi", voice: "alloy" })).rejects.toBe(err);
  });
});

describe("OpenAIVoiceProvider — STT", () => {
  it("transcribes OGG via toFile + transcriptions.create", async () => {
    const provider = createProvider();
    const audio = Buffer.from([0x4f, 0x67, 0x67, 0x53]); // "OggS" magic
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: "hello there" });

    const result = await provider.stt({ audio, mediaType: "audio/ogg" });

    expect(mockToFile).toHaveBeenCalledWith(audio, "audio.ogg", { type: "audio/ogg" });
    const callArgs = mockTranscriptionsCreate.mock.calls[0]![0];
    expect(callArgs.model).toBe("gpt-4o-mini-transcribe");
    // The Uploadable produced by toFile is passed through as-is.
    expect(callArgs.file).toMatchObject({ __sentinel: "uploadable", filename: "audio.ogg" });
    // No language hint when caller didn't supply one.
    expect(callArgs).not.toHaveProperty("language");

    expect(result.text).toBe("hello there");
  });

  it("passes a language hint through to the SDK", async () => {
    const provider = createProvider();
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: "bonjour" });

    await provider.stt({ audio: Buffer.from([]), mediaType: "audio/ogg", language: "fr" });

    expect(mockTranscriptionsCreate.mock.calls[0]![0].language).toBe("fr");
  });

  it.each([
    ["audio/ogg", "audio.ogg"],
    ["audio/opus", "audio.ogg"],
    ["audio/mpeg", "audio.mp3"],
    ["audio/mp3", "audio.mp3"],
    ["audio/wav", "audio.wav"],
    ["audio/m4a", "audio.m4a"],
    ["audio/mp4", "audio.mp4"],
    ["audio/flac", "audio.flac"],
    ["audio/webm", "audio.webm"],
  ])("derives filename %s → %s", async (mediaType, expectedName) => {
    const provider = createProvider();
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: "" });

    await provider.stt({ audio: Buffer.from([]), mediaType });

    expect(mockToFile).toHaveBeenCalledWith(expect.any(Buffer), expectedName, {
      type: mediaType,
    });
  });

  it("falls back to .bin when mediaType has no recognizable subtype", async () => {
    const provider = createProvider();
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: "" });

    await provider.stt({ audio: Buffer.from([]), mediaType: "garbage" });

    expect(mockToFile).toHaveBeenCalledWith(expect.any(Buffer), "audio.bin", {
      type: "garbage",
    });
  });

  it("respects an explicit model override", async () => {
    const provider = createProvider();
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: "" });

    await provider.stt({
      audio: Buffer.from([]),
      mediaType: "audio/ogg",
      model: "whisper-1",
    });

    expect(mockTranscriptionsCreate.mock.calls[0]![0].model).toBe("whisper-1");
  });

  it("propagates SDK errors verbatim", async () => {
    const provider = createProvider();
    const err = new Error("429 Too Many Requests");
    mockTranscriptionsCreate.mockRejectedValueOnce(err);

    await expect(provider.stt({ audio: Buffer.from([]), mediaType: "audio/ogg" })).rejects.toBe(
      err,
    );
  });
});
