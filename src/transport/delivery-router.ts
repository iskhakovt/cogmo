import type { StreamEvent } from "../llm/types.js";
import type { TransportStore } from "./store/index.js";
import {
  type Adapter,
  isStreamingAdapter,
  type StreamHandle,
  type StreamingAdapter,
} from "./types.js";

/**
 * Handle to an in-progress delivery — fans out to both streaming and batch targets.
 *
 * The orchestrator calls push() during streaming, finish()/abort() at the end,
 * and deliverBatch() after persisting the final message.
 */
export interface DeliveryHandle {
  push(event: StreamEvent): Promise<void>;
  finish(): Promise<void>;
  abort(error: string): Promise<void>;
  deliverBatch(content: string): Promise<void>;
}

/**
 * Unified delivery for both streaming and batch.
 *
 * prepare() resolves all routing targets, partitions by adapter type,
 * opens stream handles for StreamingAdapters, and returns a DeliveryHandle.
 */
export interface DeliveryRouter {
  prepare(conversationId: string, runId: string): Promise<DeliveryHandle>;
}

export interface DeliveryRouterDeps {
  adapters: Map<string, Adapter | StreamingAdapter>;
  transportStore: TransportStore;
}

/**
 * Create a delivery router that resolves routing targets and partitions
 * them into streaming (real-time) and batch (after persist) paths.
 */
export function createDeliveryRouter(deps: DeliveryRouterDeps): DeliveryRouter {
  const { adapters, transportStore } = deps;

  return {
    async prepare(conversationId: string, runId: string): Promise<DeliveryHandle> {
      const sessions = await transportStore.getActiveSessionsForConversation(conversationId);

      const streamHandles: StreamHandle[] = [];
      const batchTargets: Array<{ platformAddress: string; adapter: Adapter }> = [];

      for (const session of sessions) {
        const adapter = adapters.get(session.channelId);
        if (!adapter) continue;

        if (isStreamingAdapter(adapter)) {
          const handle = await adapter.openStream(session.platformAddress, runId);
          streamHandles.push(handle);
        } else {
          batchTargets.push({ platformAddress: session.platformAddress, adapter });
        }
      }

      return {
        async push(event: StreamEvent): Promise<void> {
          for (const handle of streamHandles) {
            await handle.push(event);
          }
        },
        async finish(): Promise<void> {
          for (const handle of streamHandles) {
            await handle.finish();
          }
        },
        async abort(error: string): Promise<void> {
          for (const handle of streamHandles) {
            await handle.abort(error);
          }
        },
        async deliverBatch(content: string): Promise<void> {
          for (const { platformAddress, adapter } of batchTargets) {
            await adapter.deliver(platformAddress, content);
          }
        },
      };
    },
  };
}
