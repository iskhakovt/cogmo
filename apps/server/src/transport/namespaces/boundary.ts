import type { Inngest } from "inngest";
import type { Result } from "neverthrow";
import { type BoundaryResolvedReason, buildBoundaryPendingEvent } from "../../inngest/events.js";
import {
  type BoundaryChoice,
  type BoundaryResolved,
  type ResolveBoundaryError,
  resolveBoundary,
} from "../boundary/resolve-boundary.js";
import type {
  BoundaryPendingRow,
  BufferedInboundEntry,
  PriorClosedConversation,
} from "../store/index.js";
import type { TransportContext } from "./context.js";

/**
 * Boundary-hold UX surface — see `design/transport/sessions.md` →
 * "Boundary hold." Adapters use this to defer auto-rotation: when
 * `resolveSession` returns null, ask the user whether to resume the
 * previous conversation instead of silently starting fresh.
 */
export interface BoundaryNamespace {
  /**
   * Snapshot of the most-recently-closed prior conversation for this address,
   * gated on `minUserTurns`. Adapters call this after `resolveSession` returns
   * null to decide whether the rotation deserves a boundary-resume prompt.
   * Returns `null` when there's no prior, when the prior was a one-shot, or
   * when (rarely) the resolveSession safety-net didn't close the stale session.
   * `snippetMaxChars` caps the returned `firstUserSnippet`.
   */
  peek(
    platformAddress: string,
    minUserTurns: number,
    snippetMaxChars: number,
  ): Promise<PriorClosedConversation | null>;

  /** Is there a hold open on this chat right now? Used by the adapter to batch follow-up messages. */
  findActive(platformAddress: string): Promise<BoundaryPendingRow | null>;

  /**
   * Start a new hold: persist the boundary_pending row carrying the first
   * buffered inbound + the prompt message id, then emit
   * `conversation/boundary/pending` so the waiter starts ticking.
   * Returns the row id so the adapter can encode it into the inline-keyboard
   * `callback_data`.
   */
  start(params: {
    platformAddress: string;
    platformUserHandle: string;
    priorConversationId: string;
    promptMessageId: string;
    firstInbound: BufferedInboundEntry;
    timeoutMs: number;
  }): Promise<{ boundaryId: string }>;

  /** Append a follow-up inbound to an open hold's buffer. */
  append(boundaryId: string, entry: BufferedInboundEntry): Promise<void>;

  /**
   * Resolve an open hold — drain its buffer, swap or create the session,
   * emit `inbound/arrived` per drained entry + `boundary/resolved`.
   * Idempotent. See `resolveBoundary` for semantics.
   */
  resolve(args: {
    boundaryId: string;
    choice: BoundaryChoice;
    reason: BoundaryResolvedReason;
  }): Promise<Result<BoundaryResolved, ResolveBoundaryError>>;
}

export function createBoundary(
  deps: TransportContext & { inngest: Inngest; defaultProfileId: string },
): BoundaryNamespace {
  const { channelId, runInTx, transportStore, agentStore, inngest, defaultProfileId } = deps;
  return {
    async peek(platformAddress, minUserTurns, snippetMaxChars) {
      const row = await runInTx((tx) =>
        transportStore.peekPriorClosedConversation(
          tx,
          channelId,
          platformAddress,
          minUserTurns,
          snippetMaxChars,
        ),
      );
      return row ?? null;
    },

    async findActive(platformAddress) {
      const row = await runInTx((tx) =>
        transportStore.getBoundaryPendingByAddress(tx, channelId, platformAddress),
      );
      return row ?? null;
    },

    async start(params) {
      // Wall-clock from the bot host, not the DB. Used by the
      // `boundary-janitor` cron to detect orphan rows; the waiter sleeps
      // on `event.data.timeoutMs` instead. Bot/DB clock skew can shift
      // janitor's "expired?" judgment by the skew amount — at single-host
      // Cogmo scale this is negligible. If the waiter is ever rewired to
      // read `expires_at`, switch this to `now() + interval` in SQL to
      // pin both clocks to the same source.
      const expiresAt = new Date(Date.now() + params.timeoutMs);
      const { id } = await runInTx((tx) =>
        transportStore.createBoundaryPending(tx, {
          channelId,
          platformAddress: params.platformAddress,
          platformUserHandle: params.platformUserHandle,
          priorConversationId: params.priorConversationId,
          promptMessageId: params.promptMessageId,
          bufferedInbounds: [params.firstInbound],
          expiresAt,
        }),
      );
      await inngest.send(
        buildBoundaryPendingEvent({
          boundaryId: id,
          channelId,
          platformAddress: params.platformAddress,
          timeoutMs: params.timeoutMs,
        }),
      );
      return { boundaryId: id };
    },

    async append(boundaryId, entry) {
      await runInTx((tx) => transportStore.appendBoundaryBuffer(tx, boundaryId, entry));
    },

    async resolve(args) {
      return resolveBoundary(
        {
          runInTx,
          transportStore,
          agentStore,
          inngest,
          channelId,
          defaultProfileId,
        },
        args,
      );
    },
  };
}
