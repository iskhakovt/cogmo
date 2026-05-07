import OpenAI, { toFile } from "openai";
import type {
  SttParams,
  SttProvider,
  SttResult,
  TtsParams,
  TtsProvider,
  TtsResult,
} from "./types.js";

const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_TTS_VOICE = "alloy";
const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe";

export interface OpenAIVoiceConfig {
  apiKey: string;
  /** Override the default endpoint (e.g. for self-hosted compatible providers). */
  baseURL?: string;
}

/**
 * OpenAI implementation of both `TtsProvider` and `SttProvider`.
 *
 * Reuses the `openai` SDK already pulled in by the LLM provider stack —
 * no new runtime dependency. OGG/Opus output is emitted directly via
 * `response_format: "opus"` so Telegram's `sendVoice` works without
 * an ffmpeg conversion step.
 */
export class OpenAIVoiceProvider implements TtsProvider, SttProvider {
  readonly name = "openai";
  #client: OpenAI;

  constructor(config: OpenAIVoiceConfig) {
    this.#client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
  }

  async tts(params: TtsParams): Promise<TtsResult> {
    // Map our format hint to OpenAI's `response_format`. OGG resolves to
    // `opus` (the SDK literal); MP3 resolves to `mp3`. Default to opus —
    // it's the only format that renders as a Telegram voice bubble.
    const responseFormat: "opus" | "mp3" = params.format === "mp3" ? "mp3" : "opus";

    const response = await this.#client.audio.speech.create({
      input: params.text,
      model: params.model ?? DEFAULT_TTS_MODEL,
      voice: params.voice || DEFAULT_TTS_VOICE,
      response_format: responseFormat,
    });

    const arrayBuffer = await response.arrayBuffer();
    const audio = Buffer.from(arrayBuffer);

    return {
      audio,
      mediaType: responseFormat === "opus" ? "audio/ogg" : "audio/mpeg",
    };
  }

  async stt(params: SttParams): Promise<SttResult> {
    // toFile builds an Uploadable from a Buffer. The filename's extension
    // is the only signal the SDK gives the API about input format —
    // derive from mediaType so OGG inputs get `.ogg`, MP3 gets `.mp3`,
    // etc.
    const filename = filenameForMediaType(params.mediaType);
    const file = await toFile(params.audio, filename, { type: params.mediaType });

    const transcription = await this.#client.audio.transcriptions.create({
      file,
      model: params.model ?? DEFAULT_STT_MODEL,
      ...(params.language ? { language: params.language } : {}),
    });

    return {
      text: transcription.text,
    };
  }
}

const MEDIA_TYPE_TO_EXT: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mp4": "mp4",
  "audio/flac": "flac",
};

function filenameForMediaType(mediaType: string): string {
  const ext = MEDIA_TYPE_TO_EXT[mediaType] ?? mediaType.split("/")[1] ?? "bin";
  return `audio.${ext}`;
}
