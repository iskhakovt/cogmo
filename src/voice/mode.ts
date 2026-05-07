import type { VoiceMode } from "./types.js";

/**
 * Inputs to per-turn voice-mode resolution.
 *
 * The four boolean gates and the 3-value preference enums combine to a
 * single boolean: "should this turn be voiced?". Resolved once at
 * turn-start (durable step) and consumed in two places — prompt
 * assembly (voice-style hint) and delivery (TTS branch). See
 * design/voice.md.
 */
export interface ResolveVoiceModeInput {
  /** Adapter for this turn's primary delivery target supports voice (Telegram yes, Direct CLI no). */
  adapterSupportsVoice: boolean;
  /** Voice config row exists in DB with valid TTS credentials. */
  voiceConfigPresent: boolean;
  /** Per-conversation override. NULL = follow profile. */
  conversationMode: VoiceMode | null;
  /** Profile-level default (always non-null). */
  profileMode: VoiceMode;
  /** True if any block in the most recent inbound row's content was a voice block. */
  lastInboundWasVoice: boolean;
}

/**
 * Compute whether THIS turn's reply should be voiced.
 *
 * Precedence: capability before policy before user preference. Each gate
 * collapses on `false` — the order is for readability, not semantics.
 */
export function resolveVoiceMode(input: ResolveVoiceModeInput): boolean {
  if (!input.adapterSupportsVoice) return false;
  if (!input.voiceConfigPresent) return false;
  const effective = input.conversationMode ?? input.profileMode;
  if (effective === "never") return false;
  if (effective === "always") return true;
  // auto — mirror inbound modality
  return input.lastInboundWasVoice;
}
