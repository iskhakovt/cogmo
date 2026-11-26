import type { Result } from "neverthrow";
import type { JsonValue } from "type-fest";
import type { StreamEvent } from "../llm/types.js";
import type { OutboundVoice, RenderedMessage } from "./adapter-module.js";
import type { Transport } from "./transport.js";

/** Why a receive loop is retrying: a 409 backoff (`conflict`), or an outcome the platform client retries itself. */
export type RetryCause =
  | "conflict"
  | "network"
  | "rate_limited"
  | "server_error"
  | "client_error"
  | "bad_reply"
  | "unknown";

/** `code` is normalized and is all `/health` shows; `detail` is the platform's text, for logs, which mask the token. */
export interface ChannelError {
  readonly code: string;
  readonly detail: string | null;
}

/** Where a channel's receive loop is. Times are monotonic ms (`performance.now()`). */
export type LoopState =
  | { readonly kind: "starting" }
  | { readonly kind: "receiving" }
  | {
      readonly kind: "retrying";
      readonly since: number;
      readonly cause: RetryCause;
      readonly error: ChannelError;
    }
  | {
      readonly kind: "failed";
      readonly reason: "unauthorized" | "rejected" | "ended";
      readonly error: ChannelError | null;
    }
  | { readonly kind: "stopped" };

/** A channel's receive loop, projected from its adapter's state (design/liveness.md → Channel contract). */
export interface ChannelLiveness {
  readonly state: LoopState;
  /** The later of the last valid update batch or finished update, and the current run's start or backoff. */
  readonly progressAt: number;
  /** When handling the update in hand began; null with none in hand. */
  readonly handlingSince: number | null;
  /** Conflict restarts in a row; zero once a run resets the streak. */
  readonly conflicts: number;
  readonly thresholds: { readonly staleAfterMs: number; readonly wedgedAfterMs: number };
}

/**
 * Running adapter instance — handles platform-specific delivery.
 * Batch-only: receives the complete message after persist.
 */
export interface Adapter {
  stop(): Promise<void>;
  /** The receive loop's projection; `null` for an adapter with no loop of its own. */
  liveness(): ChannelLiveness | null;
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
  /** Same contract as `Adapter.liveness`. */
  liveness(): ChannelLiveness | null;
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
 *
 * Delivery failures come back as values, never as rejections. A handle that
 * fails stops writing: every later call errs with the same reason, and the
 * adapter's next `openStream` for the run returns a fresh handle.
 */
export interface StreamHandle {
  push(event: StreamEvent): Promise<Result<void, string>>;
  /** Write out what remains; resolves once the stream has settled. */
  finish(): Promise<Result<void, string>>;
  /** Close the stream showing `error`; resolves once the stream has settled. */
  abort(error: string): Promise<Result<void, string>>;
}

export function isStreamingAdapter(
  adapter: Adapter | StreamingAdapter,
): adapter is StreamingAdapter {
  return "openStream" in adapter;
}

/**
 * Factory — connect to platform, return a ready-to-use adapter.
 * The runtime calls this once per channel row in the DB.
 *
 * @public The adapter-plugin contract in design/transport/adapters.md.
 */
export type StartAdapter<T extends Adapter = Adapter> = (
  transport: Transport,
  credentials: JsonValue,
) => Promise<T>;
