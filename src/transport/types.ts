import type { JsonValue } from "type-fest";
import type { StreamEvent } from "../llm/types.js";
import type { Transport } from "./transport.js";

/**
 * Running adapter instance — handles platform-specific delivery.
 * Batch-only: receives the complete message after persist.
 */
export interface Adapter {
  stop(): Promise<void>;
  deliver(platformAddress: string, content: JsonValue): Promise<void>;
}

/**
 * Streaming adapter — delivers tokens in real-time via progressive message editing.
 * Separate interface from Adapter — no inheritance. An adapter class may implement both.
 */
export interface StreamingAdapter {
  stop(): Promise<void>;
  openStream(platformAddress: string, runId: string): Promise<StreamHandle>;
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
