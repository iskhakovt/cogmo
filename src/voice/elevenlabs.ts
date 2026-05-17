import type { TtsParams, TtsProvider, TtsResult } from "./types.js";

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_MODEL = "eleven_turbo_v2_5";
/** Rachel — bundled in every ElevenLabs account; safe default before the operator picks one. */
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";
/** OGG/Opus output preset Telegram's `sendVoice` accepts directly. */
const OPUS_OUTPUT_FORMAT = "opus_48000_128";
const MP3_OUTPUT_FORMAT = "mp3_44100_128";

export interface ElevenLabsTtsConfig {
  apiKey: string;
  /** Override the default endpoint (e.g. for self-hosted relays). No trailing slash. */
  baseURL?: string;
  /**
   * Custom fetch — used by integration tests to swap in a record/replay
   * interceptor. Production passes nothing and the global fetch is used.
   */
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * ElevenLabs implementation of `TtsProvider`. Calls the REST endpoint
 * directly via `fetch` — the official `@elevenlabs/elevenlabs-js` SDK is
 * heavy and the API surface is one POST with three headers, so a hand-rolled
 * client carries less weight than a runtime dependency.
 *
 * Returns OGG/Opus directly via `output_format=opus_48000_128`, which
 * Telegram's `sendVoice` accepts without an ffmpeg conversion step.
 */
export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = "elevenlabs";
  #apiKey: string;
  #baseURL: string;
  #fetch: typeof fetch;

  constructor(config: ElevenLabsTtsConfig) {
    this.#apiKey = config.apiKey;
    this.#baseURL = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async tts(params: TtsParams): Promise<TtsResult> {
    const wantMp3 = params.format === "mp3";
    const outputFormat = wantMp3 ? MP3_OUTPUT_FORMAT : OPUS_OUTPUT_FORMAT;
    const accept = wantMp3 ? "audio/mpeg" : "audio/ogg";
    const voice = params.voice || DEFAULT_VOICE;
    const model = params.model ?? DEFAULT_MODEL;

    const url = `${this.#baseURL}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${outputFormat}`;
    const response = await this.#fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": this.#apiKey,
        accept,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: params.text, model_id: model }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`ElevenLabs TTS failed (${response.status}): ${body || response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuffer),
      mediaType: wantMp3 ? "audio/mpeg" : "audio/ogg",
    };
  }
}
