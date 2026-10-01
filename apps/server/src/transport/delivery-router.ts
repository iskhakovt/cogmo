import { err, ok, type Result } from "neverthrow";
import type { Transactor } from "../db/index.js";
import type { StreamEvent } from "../llm/types.js";
import { logger } from "../logger.js";
import { describeError } from "../util/describe-error.js";
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
  type StreamOpts,
} from "./types.js";

/**
 * Routing context for target resolution — passed from the orchestrator.
 *
 * `kind` selects how primary target sessions are picked:
 * `"reply"` uses source routing (sessions that contributed inbounds in
 * this turn's range); `"broadcast"` falls back to every reachable session
 * on the conversation, used for scheduled-fire turns where the synthetic
 * inbound has no originating session. Both modes apply the `receive:"all"`
 * overlay for private conversations.
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
  /**
   * Profile-derived streaming presentation knobs forwarded to every active
   * `StreamingAdapter.openStream` call for this turn. Optional only because
   * the off-path `notifyConversation` surface has no profile in scope.
   */
  streamOpts?: StreamOpts;
}

/** A stream target a fan-out could not reach. */
export interface StreamFailure {
  sessionId: string;
  reason: string;
}

/** The stream targets a fan-out could not reach, each with its reason. */
export interface StreamDeliveryError {
  readonly failures: ReadonlyArray<StreamFailure>;
}

/**
 * Handle to an in-progress delivery — fans out to both streaming and batch targets.
 *
 * The orchestrator calls push() during streaming, finish()/abort() at the end,
 * and deliverBatch() after persisting the final message.
 *
 * `push`, `finish` and `abort` reach every stream target, concurrently,
 * whichever of them fail; they err with every target that failed.
 */
export interface DeliveryHandle {
  push(event: StreamEvent): Promise<Result<void, StreamDeliveryError>>;
  finish(): Promise<Result<void, StreamDeliveryError>>;
  abort(error: string): Promise<Result<void, StreamDeliveryError>>;
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
   * Deliver the reply to sessions whose stream failed at finish, through
   * their adapter's batch `deliver`, after persist. Such a stream may have
   * shown nothing (append-only mode writes only at chunk boundaries and at
   * finish) or a cut-short preview. Media went out mid-stream, so only the
   * text goes. A session whose adapter has no `deliver` is skipped. Rejects
   * once every session has been tried, if any delivery failed.
   */
  deliverUnstreamed(sessionIds: ReadonlyArray<string>, content: string): Promise<void>;
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
      if (ctx.kind === "broadcast" && !ctx.isPrivate) {
        // Broadcast routing fans out to every reachable session on the
        // conversation. On a group thread that would leak proactive
        // context into unrelated chats. Scheduled fires only target
        // private conversations; any other broadcast caller is a bug.
        throw new Error("broadcast routing is not allowed on non-private conversations");
      }

      const { primarySessions, receiveAllSessions } = await runInTx(async (tx) => {
        const primary =
          ctx.kind === "broadcast"
            ? await transportStore.getActiveSessionsForConversation(tx, ctx.conversationId)
            : await transportStore.getSourceSessions(tx, {
                conversationId: ctx.conversationId,
                prevCursor: ctx.prevCursor,
                maxInboundId: ctx.maxInboundId,
              });
        // Receive-all overlay only applies to private conversations.
        const receiveAll = ctx.isPrivate
          ? await transportStore.getReceiveAllSessions(tx, ctx.conversationId)
          : [];
        return { primarySessions: primary, receiveAllSessions: receiveAll };
      });

      // Merge + dedup by session ID
      const sessionMap = new Map(primarySessions.map((s) => [s.id, s]));
      for (const s of receiveAllSessions) {
        sessionMap.set(s.id, s);
      }
      const sessions = [...sessionMap.values()];

      if (sessions.length === 0) {
        logger.warn({ conversationId: ctx.conversationId }, "no routing targets found");
      }

      const streamTargets: StreamTarget[] = [];
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
          const handle = await entry.adapter.openStream(
            session.platformAddress,
            ctx.runId,
            ctx.streamOpts,
          );
          streamTargets.push({
            sessionId: session.id,
            platformAddress: session.platformAddress,
            entry,
            handle,
          });
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
        push: (event) => fanOut(streamTargets, (handle) => handle.push(event)),
        finish: () => fanOut(streamTargets, (handle) => handle.finish()),
        abort: (error) => fanOut(streamTargets, (handle) => handle.abort(error)),
        async deliverUnstreamed(sessionIds, content): Promise<void> {
          const targets = streamTargets.filter((target) => sessionIds.includes(target.sessionId));
          const settled = await Promise.allSettled(
            targets.map(async ({ sessionId, platformAddress, entry }) => {
              if (!hasDeliver(entry.adapter)) {
                logger.warn({ sessionId }, "deliverUnstreamed: adapter has no batch deliver");
                return;
              }
              await entry.adapter.deliver(
                platformAddress,
                entry.renderOutput ? entry.renderOutput(content) : content,
              );
            }),
          );
          const rejected = settled.flatMap((outcome) =>
            outcome.status === "rejected" ? [outcome.reason] : [],
          );
          if (rejected.length === 1) throw rejected[0];
          if (rejected.length > 1) throw new AggregateError(rejected, "deliverUnstreamed failed");
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

/**
 * Push `event`, throwing when a target failed. It runs inside a step, where a
 * throw is how a failure reaches Inngest: it
 * fails the step, and the step's retry reopens the streams. The failed handle
 * has left its adapter, so the retry streams into a fresh one.
 */
export async function pushOrThrow(delivery: DeliveryHandle, event: StreamEvent): Promise<void> {
  const pushed = await delivery.push(event);
  if (pushed.isErr()) {
    const reasons = pushed.error.failures.map((f) => f.reason).join("; ");
    throw new Error(`stream delivery failed: ${reasons}`);
  }
}

/** An open stream, and the session and adapter it delivers to. */
interface StreamTarget {
  sessionId: string;
  platformAddress: string;
  entry: AdapterEntry;
  handle: StreamHandle;
}

/**
 * Call every handle at once and collect the failures. A handle that rejects
 * rather than returning its failure counts as failed all the same.
 */
async function fanOut(
  targets: ReadonlyArray<StreamTarget>,
  call: (handle: StreamHandle) => Promise<Result<void, string>>,
): Promise<Result<void, StreamDeliveryError>> {
  const settled = await Promise.allSettled(targets.map(({ handle }) => call(handle)));
  const failures = settled.flatMap((outcome, i): StreamFailure[] => {
    const sessionId = targets[i]?.sessionId ?? "";
    if (outcome.status === "rejected") {
      return [{ sessionId, reason: describeError(outcome.reason) }];
    }
    return outcome.value.isErr() ? [{ sessionId, reason: outcome.value.error }] : [];
  });
  return failures.length === 0 ? ok(undefined) : err({ failures });
}

function hasDeliver(adapter: AdapterEntry["adapter"]): adapter is Adapter {
  return "deliver" in adapter;
}
