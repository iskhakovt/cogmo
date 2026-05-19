import type { Inngest } from "inngest";
import { err, ok, type Result } from "neverthrow";
import type { AgentStore } from "../../agent/store/index.js";
import type { Transactor } from "../../db/index.js";
import {
  type BoundaryResolvedReason,
  buildBoundaryResolvedEvent,
  buildInboundArrivedEvent,
} from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { TransportStore } from "../store/index.js";

/**
 * Caller-supplied next-state for the hold.
 *  - `resume-prior` — swap to whatever conversation the boundary row points at
 *    (the original "pick up where we left off" path; resolver pulls the id
 *    from the row so callers like the Resume button don't have to fetch it).
 *  - `resume-target` — swap to a user-specified conversation (from `/resume
 *    <alias>` invoked while a hold is open).
 *  - `fresh` — create a new conversation with the chat-default → global-default
 *    profile fallback chain.
 *
 * All variants use the same ACL semantics as the existing `/resume` command.
 */
export type BoundaryChoice =
  | { kind: "resume-prior" }
  | { kind: "resume-target"; conversationId: string }
  | { kind: "fresh"; profileId?: string };

export interface ResolveBoundaryDeps {
  runInTx: Transactor;
  transportStore: TransportStore;
  agentStore: AgentStore;
  inngest: Inngest;
  channelId: string;
  defaultProfileId: string;
}

export interface ResolveBoundaryArgs {
  boundaryId: string;
  choice: BoundaryChoice;
  reason: BoundaryResolvedReason;
}

export interface BoundaryResolved {
  sessionId: string;
  conversationId: string;
  drainedInboundCount: number;
  /** Platform address of the resolved chat — convenient for callers that want to send a follow-up. */
  platformAddress: string;
}

export type ResolveBoundaryError =
  | { code: "boundary_not_found" }
  | { code: "identity_rejected" }
  | { code: "conversation_not_found" }
  | { code: "access_denied" };

/**
 * Drain a `boundary_pending` row into `inbound_messages` against the chosen
 * conversation, swap or create the session as needed, delete the holding row,
 * and emit one `inbound/arrived` per drained entry plus a single
 * `boundary/resolved`. Idempotent: a second call for a row that's already
 * been resolved (waiter racing a button tap) returns `boundary_not_found`.
 *
 * All DB work runs in a single tx — REPEATABLE READ snapshots make the
 * session bind + buffer drain + row delete atomic. Event emission happens
 * after commit so retries replay only the durable state, not the bus side
 * effects.
 */
export async function resolveBoundary(
  deps: ResolveBoundaryDeps,
  args: ResolveBoundaryArgs,
): Promise<Result<BoundaryResolved, ResolveBoundaryError>> {
  const { runInTx, transportStore, agentStore, channelId, defaultProfileId } = deps;

  const dbResult = await runInTx(async (tx) => {
    const row = await transportStore.getBoundaryPendingById(tx, args.boundaryId);
    if (!row) return { kind: "missing" } as const;

    let sessionId: string;
    let conversationId: string;

    if (args.choice.kind === "resume-prior" || args.choice.kind === "resume-target") {
      const targetConvId =
        args.choice.kind === "resume-prior" ? row.priorConversationId : args.choice.conversationId;

      // Identity first, mirroring the fresh branch — an `identity_rejected`
      // handle short-circuits without paying for the conversation read.
      const identity = await transportStore.resolveUser(tx, channelId, row.platformUserHandle);
      if (!identity) return { kind: "err", code: "identity_rejected" } as const;

      const conv = await agentStore.getConversation(tx, targetConvId);
      if (!conv) return { kind: "err", code: "conversation_not_found" } as const;
      if (identity.userId !== conv.userId) {
        return { kind: "err", code: "access_denied" } as const;
      }

      const swapped = await transportStore.swapSession(tx, channelId, row.platformAddress, {
        conversationId: targetConvId,
        status: "active",
        receive: "routed",
      });
      sessionId = swapped.id;
      conversationId = targetConvId;
    } else {
      const identity = await transportStore.resolveUser(tx, channelId, row.platformUserHandle);
      if (!identity) return { kind: "err", code: "identity_rejected" } as const;

      // Explicit profile from `/new <name>` wins; else fall through to the
      // chat-default → global-default chain so `boundary.resolve({ kind: "fresh" })`
      // matches `transport.createConversation`'s implicit choice.
      let profileId = args.choice.profileId;
      if (!profileId) {
        const chatDefault = await transportStore.getChatDefaultProfile(
          tx,
          channelId,
          row.platformAddress,
        );
        profileId = chatDefault?.profileId ?? defaultProfileId;
      }

      const conv = await agentStore.createConversation(tx, {
        userId: identity.userId,
        profileId,
        isPrivate: true,
      });
      const created = await transportStore.createSession(tx, {
        channelId,
        platformAddress: row.platformAddress,
        conversationId: conv.id,
        status: "active",
        receive: "routed",
      });
      sessionId = created.id;
      conversationId = conv.id;
    }

    const inboundIds: string[] = [];
    for (const entry of row.bufferedInbounds) {
      const persisted = await transportStore.persistInbound(tx, {
        source: "user",
        channelSessionId: sessionId,
        conversationId,
        content: entry.content,
        platformTs: new Date(entry.platformTs),
      });
      inboundIds.push(persisted.id);
    }

    await transportStore.deleteBoundaryPending(tx, args.boundaryId);

    return {
      kind: "ok",
      sessionId,
      conversationId,
      inboundIds,
      platformAddress: row.platformAddress,
    } as const;
  });

  if (dbResult.kind === "missing") return err({ code: "boundary_not_found" });
  if (dbResult.kind === "err") return err({ code: dbResult.code });

  for (const inboundMessageId of dbResult.inboundIds) {
    // `resolveBoundary` is invoked both from raw async contexts (callback
    // handlers, command handlers) AND from inside `step.run` bodies (waiter
    // wakeup, janitor row-by-row). In the latter, a thrown error after some
    // sends have already gone through replays the entire step body on
    // retry — including the prior emits. The `inbound-arrived-${id}`
    // dedup id collapses those duplicates at the bus, so router runs are
    // exactly-once per inbound regardless of how many step.run retries the
    // outer caller chains around us. Same posture as the
    // `buildBoundaryResolvedEvent` send below — dedup id is load-bearing
    // for retry safety, not just nice-to-have.
    await deps.inngest.send(
      buildInboundArrivedEvent({
        conversationId: dbResult.conversationId,
        inboundMessageId,
      }),
    );
  }
  await deps.inngest.send(
    buildBoundaryResolvedEvent({
      boundaryId: args.boundaryId,
      channelId,
      platformAddress: dbResult.platformAddress,
      resolvedConversationId: dbResult.conversationId,
      reason: args.reason,
      drainedInboundCount: dbResult.inboundIds.length,
    }),
  );

  logger.info(
    {
      boundaryId: args.boundaryId,
      reason: args.reason,
      conversationId: dbResult.conversationId,
      drained: dbResult.inboundIds.length,
    },
    "boundary resolved",
  );

  return ok({
    sessionId: dbResult.sessionId,
    conversationId: dbResult.conversationId,
    drainedInboundCount: dbResult.inboundIds.length,
    platformAddress: dbResult.platformAddress,
  });
}
