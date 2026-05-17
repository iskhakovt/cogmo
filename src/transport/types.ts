import type { JsonValue } from "type-fest";
import type { StreamEvent } from "../llm/types.js";
import type { OutboundVoice, RenderedMessage } from "./adapter-module.js";
import type { Transport } from "./transport.js";

/**
 * Running adapter instance — handles platform-specific delivery.
 * Batch-only: receives the complete message after persist.
 */
export interface Adapter {
  stop(): Promise<void>;
  deliver(platformAddress: string, content: RenderedMessage | JsonValue): Promise<void>;
  /**
   * Optional voice delivery — adapters that support voice messages
   * implement this; others omit it and the delivery router skips them
   * for voice fan-out. Called once per active session per turn after
   * the orchestrator has TTS'd the assistant text.
   */
  sendVoice?(platformAddress: string, audio: OutboundVoice): Promise<void>;
}

/**
 * Streaming adapter — delivers tokens in real-time via progressive message editing.
 * Separate interface from Adapter — no inheritance. An adapter class may implement both.
 */
export interface StreamingAdapter {
  stop(): Promise<void>;
  openStream(platformAddress: string, runId: string, opts?: StreamOpts): Promise<StreamHandle>;
  /** Same shape as Adapter.sendVoice — optional capability flag. */
  sendVoice?(platformAddress: string, audio: OutboundVoice): Promise<void>;
}

/**
 * Per-turn presentation knobs derived from the active profile and passed to
 * the streaming adapter when the stream opens. Adapters may ignore knobs that
 * don't apply (a future SSE-style web stream wouldn't honor chunkChars at
 * all). Today: Telegram honors both.
 *
 * `chunkChars` — soft cap on a single message's source length before the
 *   adapter rotates to a new message. Lower for short-burst UX.
 * `allowEdits` — when false, the adapter never edits a message mid-stream;
 *   it only emits whole chunks on boundary/finish, drops tool/status
 *   banners (they're a streaming-edit affordance), and surfaces progress
 *   via the platform-native typing indicator.
 */
export interface StreamOpts {
  chunkChars: number;
  allowEdits: boolean;
}

/**
 * Handle to an in-progress stream delivery.
 * The adapter is a renderer — it decides how to display each StreamEvent.
 */
export interface StreamHandle {
  push(event: StreamEvent): Promise<void>;
  finish(): Promise<void>;
  abort(error: string): Promise<void>;
}

export function isStreamingAdapter(
  adapter: Adapter | StreamingAdapter,
): adapter is StreamingAdapter {
  return "openStream" in adapter;
}

/**
 * Factory — connect to platform, return a ready-to-use adapter.
 * The runtime calls this once per channel row in the DB.
 */
export type StartAdapter<T extends Adapter = Adapter> = (
  transport: Transport,
  credentials: JsonValue,
) => Promise<T>;
