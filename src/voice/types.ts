/**
 * Provider-agnostic voice types.
 *
 * Two interfaces (TTS + STT) instead of a single combined VoiceProvider so
 * an operator can mix providers — e.g. OpenAI for transcription (cheap,
 * accurate) and ElevenLabs for synthesis (better voice character) — without
 * either side knowing about the other. See design/voice.md.
 */

/**
 * Voice mode preference. Lives on profiles (default) and conversations
 * (override, nullable). The pgEnum values are these literals exactly.
 */
export type VoiceMode = "auto" | "always" | "never";

// --- TTS ---

export interface TtsParams {
  /** UTF-8 text to synthesize. */
  text: string;
  /** Provider-specific voice id. */
  voice: string;
  /** Provider-specific model id. */
  model?: string;
  /**
   * Requested encoding. Provider may downgrade to its closest match —
   * adapters that need a specific format must check `TtsResult.mediaType`.
   * Telegram's sendVoice requires OGG/Opus.
   */
  format?: "ogg" | "mp3";
}

export interface TtsResult {
  audio: Buffer;
  /** e.g. "audio/ogg", "audio/mpeg". */
  mediaType: string;
  /** Populated when the provider returns it; otherwise undefined. */
  durationMs?: number;
}

export interface TtsProvider {
  readonly name: string;
  tts(params: TtsParams): Promise<TtsResult>;
}

// --- STT ---

export interface SttParams {
  audio: Buffer;
  /** Input format hint (e.g. "audio/ogg" for Telegram voice clips). */
  mediaType: string;
  /** Provider-specific model id. */
  model?: string;
  /** ISO-639-1 language code. Omit to auto-detect. */
  language?: string;
}

export interface SttResult {
  text: string;
  /** Populated when the provider detects/returns it. */
  language?: string;
}

export interface SttProvider {
  readonly name: string;
  stt(params: SttParams): Promise<SttResult>;
}
