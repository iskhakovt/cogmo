import type { Transactor } from "../db/index.js";
import type { StreamEvent } from "../llm/types.js";
import { logger } from "../logger.js";
import type {
  OutboundDocument,
  OutboundImage,
  OutboundVoice,
  RenderedMessage,
} from "./adapter-module.js";
import type { TransportStore } from "./store/index.js";
import {
  type Adapter,
  isStreamingAdapter,
  type StreamHandle,
  type StreamingAdapter,
} from "./types.js";

/**
 * Routing context for target resolution — passed from the orchestrator.
 *
 * `kind` selects how target sessions are picked:
 *   - `"reply"` — source routing: deliver to every session that contributed
 *     an inbound in this turn's range. Default for turns triggered by a
 *     user-authored inbound.
 *   - `"broadcast"` — skip source routing; deliver to every reachable
 *     session on the conversation. Used when the trigger was scheduled —
 *     the synthetic inbound has no originating session to source-route
 *     against, so the response goes to whatever channels are currently
 *     attached to the conversation.
 *
 * Both modes still apply the `receive: "all"` overlay for private
 * conversations, so Web UI tabs watching the conversation always get the
 * response.
 */
export interface RoutingContext {
  conversationId: string;
  runId: string;
  isPrivate: boolean;
  /** Last inbound message ID included in this response. */
  maxInboundId: string;
  /** Previous assistant message's lastInboundMessageId (null for first response). */
  prevCursor: string | null;
  kind: "reply" | "broadcast";
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
  deliverBatch(
    content: string,
    images?: readonly OutboundImage[],
    documents?: readonly OutboundDocument[],
  ): Promise<void>;
  /**
   * Whether any active routing target supports voice delivery. Lets the
   * orchestrator skip TTS work entirely when no session can render voice
   * (e.g., Direct CLI conversations, future text-only adapters).
   */
  canDeliverVoice(): boolean;
  /**
   * Deliver a TTS clip to every active routing target whose adapter
   * implements `sendVoice`. No-op for sessions on adapters that don't
   * support voice. Called by the orchestrator AFTER the streamed text
   * has been delivered (Option B in design/voice.md — voice plus
   * transcript), so a TTS failure doesn't strand the user.
   */
  deliverVoice(audio: OutboundVoice): Promise<void>;
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
  runInTx: Transactor;
  adapters: Map<string, AdapterEntry>;
  transportStore: TransportStore;
}

/**
 * Create a delivery router that resolves routing targets via source routing
 * and partitions them into streaming (real-time) and batch (after persist) paths.
 */
export function createDeliveryRouter(deps: DeliveryRouterDeps): DeliveryRouter {
  const { runInTx, adapters, transportStore } = deps;

  return {
    async prepare(ctx: RoutingContext): Promise<DeliveryHandle> {
      // Pick targets per `kind`. `reply` uses source routing (sessions
      // that contributed an inbound this turn); `broadcast` falls back
      // to every reachable session on the conversation, used when the
      // trigger was a scheduled fire with no originating session.
      const primarySessions =
        ctx.kind === "broadcast"
          ? await runInTx((tx) =>
              transportStore.getActiveSessionsForConversation(tx, ctx.conversationId),
            )
          : await runInTx((tx) =>
              transportStore.getSourceSessions(tx, {
                conversationId: ctx.conversationId,
                prevCursor: ctx.prevCursor,
                maxInboundId: ctx.maxInboundId,
              }),
            );

      // Receive-all sessions — private conversations only
      const receiveAllSessions = ctx.isPrivate
        ? await runInTx((tx) => transportStore.getReceiveAllSessions(tx, ctx.conversationId))
        : [];

      // Merge + dedup by session ID
      const sessionMap = new Map(primarySessions.map((s) => [s.id, s]));
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
      // Voice fan-out targets — populated for both streaming and batch
      // adapters that implement `sendVoice`. Decoupled from streamHandles /
      // batchTargets so a Telegram session contributes once for text
      // (streamed) and once for voice (separate sendVoice call).
      const voiceTargets: Array<{
        platformAddress: string;
        sendVoice: NonNullable<Adapter["sendVoice"]>;
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

        // Adapters opt into voice fan-out by implementing `sendVoice`.
        // Bind to the adapter so the call site doesn't need to re-narrow.
        const send = entry.adapter.sendVoice?.bind(entry.adapter);
        if (send) {
          voiceTargets.push({ platformAddress: session.platformAddress, sendVoice: send });
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
        async deliverBatch(content, images, documents): Promise<void> {
          for (const { platformAddress, adapter, renderOutput } of batchTargets) {
            // When attachments are present, always produce a RenderedMessage
            // so adapters can find them on `.images` / `.documents` — even if
            // the channel has no renderOutput and would otherwise receive raw
            // markdown.
            const hasAttachments =
              (images && images.length > 0) || (documents && documents.length > 0);
            const rendered: RenderedMessage | string = renderOutput
              ? {
                  ...renderOutput(content),
                  ...(images && { images }),
                  ...(documents && { documents }),
                }
              : hasAttachments
                ? {
                    text: content,
                    ...(images && { images }),
                    ...(documents && { documents }),
                  }
                : content;
            await adapter.deliver(platformAddress, rendered);
          }
        },
        canDeliverVoice(): boolean {
          return voiceTargets.length > 0;
        },
        async deliverVoice(audio): Promise<void> {
          // Per-target resilience — one failed sendVoice shouldn't block
          // others, matching the per-image swallow-and-log pattern in the
          // batch path. Errors are logged at the router level so the
          // orchestrator's outcome stays "delivered" even when one
          // session's voice call fails.
          for (const { platformAddress, sendVoice } of voiceTargets) {
            try {
              await sendVoice(platformAddress, audio);
            } catch (err) {
              logger.error({ err, platformAddress }, "deliverVoice: per-session sendVoice failed");
            }
          }
        },
      };
    },

    async notifyConversation(conversationId: string, text: string): Promise<void> {
      const sessions = await runInTx((tx) =>
        transportStore.getActiveSessionsForConversation(tx, conversationId),
      );
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
