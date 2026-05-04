import type { StreamEvent } from "../llm/types.js";
import { logger } from "../logger.js";
import type { OutboundImage, RenderedMessage } from "./adapter-module.js";
import type { TransportStore } from "./store/index.js";
import {
  type Adapter,
  isStreamingAdapter,
  type StreamHandle,
  type StreamingAdapter,
} from "./types.js";

/**
 * Routing context for target resolution — passed from the orchestrator.
 */
export interface RoutingContext {
  conversationId: string;
  runId: string;
  isPrivate: boolean;
  /** Last inbound message ID included in this response. */
  maxInboundId: string;
  /** Previous assistant message's lastInboundMessageId (null for first response). */
  prevCursor: string | null;
}

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
  /**
   * Whether this delivery has any non-streaming targets.
   *
   * Lets callers skip expensive pre-delivery work (e.g., S3 downloads for
   * outbound images) when all sessions use streaming adapters that already
   * handled delivery mid-loop. Pure-Telegram setups return false.
   */
  hasBatchTargets(): boolean;
  /**
   * Deliver final content to batch (non-streaming) adapters after persist.
   * No-op for sessions handled by streaming adapters — those receive content
   * via `push` events during the loop.
   */
  deliverBatch(content: string, images?: readonly OutboundImage[]): Promise<void>;
}

/**
 * Unified delivery for both streaming and batch.
 *
 * prepare() resolves source routing targets, partitions by adapter type,
 * opens stream handles for StreamingAdapters, and returns a DeliveryHandle.
 *
 * notifyConversation() is the off-path notification surface — used by the
 * orchestrator's `onFailure` handler (and future recovery paths) to send a
 * one-shot text to every active session on a conversation. Bypasses source
 * routing entirely because there's no in-flight turn whose inbound cursor
 * we could anchor against; we just need to reach the user.
 */
export interface DeliveryRouter {
  prepare(ctx: RoutingContext): Promise<DeliveryHandle>;
  notifyConversation(conversationId: string, text: string): Promise<void>;
}

export interface AdapterEntry {
  adapter: Adapter | StreamingAdapter;
  renderOutput?: ((markdown: string) => RenderedMessage) | undefined;
}

export interface DeliveryRouterDeps {
  adapters: Map<string, AdapterEntry>;
  transportStore: TransportStore;
}

/**
 * Create a delivery router that resolves routing targets via source routing
 * and partitions them into streaming (real-time) and batch (after persist) paths.
 */
export function createDeliveryRouter(deps: DeliveryRouterDeps): DeliveryRouter {
  const { adapters, transportStore } = deps;

  return {
    async prepare(ctx: RoutingContext): Promise<DeliveryHandle> {
      // Source routing — find sessions that contributed inbound messages for this turn
      const sourceSessions = await transportStore.getSourceSessions({
        conversationId: ctx.conversationId,
        prevCursor: ctx.prevCursor,
        maxInboundId: ctx.maxInboundId,
      });

      // Receive-all sessions — private conversations only
      const receiveAllSessions = ctx.isPrivate
        ? await transportStore.getReceiveAllSessions(ctx.conversationId)
        : [];

      // Merge + dedup by session ID
      const sessionMap = new Map(sourceSessions.map((s) => [s.id, s]));
      for (const s of receiveAllSessions) {
        sessionMap.set(s.id, s);
      }
      const sessions = [...sessionMap.values()];

      if (sessions.length === 0) {
        logger.warn({ conversationId: ctx.conversationId }, "no routing targets found");
      }

      const streamHandles: StreamHandle[] = [];
      const batchTargets: Array<{
        platformAddress: string;
        adapter: Adapter;
        renderOutput?: ((markdown: string) => RenderedMessage) | undefined;
      }> = [];

      for (const session of sessions) {
        const entry = adapters.get(session.channelId);
        if (!entry) continue;

        if (isStreamingAdapter(entry.adapter)) {
          const handle = await entry.adapter.openStream(session.platformAddress, ctx.runId);
          streamHandles.push(handle);
        } else {
          batchTargets.push({
            platformAddress: session.platformAddress,
            adapter: entry.adapter,
            renderOutput: entry.renderOutput,
          });
        }
      }

      // (notifyConversation is defined below at the router level — it doesn't
      // share session state with prepare(), since failure notification can
      // arrive long after the turn that triggered it.)
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
        hasBatchTargets(): boolean {
          return batchTargets.length > 0;
        },
        async deliverBatch(content, images): Promise<void> {
          for (const { platformAddress, adapter, renderOutput } of batchTargets) {
            // When images are present, always produce a RenderedMessage so
            // adapters can find them on `.images` — even if the channel has no
            // renderOutput and would otherwise receive raw markdown.
            const rendered: RenderedMessage | string = renderOutput
              ? { ...renderOutput(content), ...(images && { images }) }
              : images
                ? { text: content, images }
                : content;
            await adapter.deliver(platformAddress, rendered);
          }
        },
      };
    },

    async notifyConversation(conversationId: string, text: string): Promise<void> {
      const sessions = await transportStore.getActiveSessionsForConversation(conversationId);
      if (sessions.length === 0) {
        logger.warn({ conversationId }, "notifyConversation: no active sessions");
        return;
      }
      for (const session of sessions) {
        const entry = adapters.get(session.channelId);
        if (!entry) continue;
        const adapter = entry.adapter;
        if (!hasDeliver(adapter)) {
          // Pure StreamingAdapter — would need an open stream to push a status,
          // but no turn is in flight here. Skip. (Telegram implements both
          // Adapter and StreamingAdapter so the production hot path is fine.)
          continue;
        }
        const rendered: RenderedMessage | string = entry.renderOutput
          ? entry.renderOutput(text)
          : text;
        try {
          await adapter.deliver(session.platformAddress, rendered);
        } catch (err) {
          logger.error(
            { err, conversationId, channelId: session.channelId },
            "notifyConversation: deliver failed",
          );
        }
      }
    },
  };
}

function hasDeliver(adapter: AdapterEntry["adapter"]): adapter is Adapter {
  return "deliver" in adapter;
}
