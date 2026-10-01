import { err, ok, type Result } from "neverthrow";
import type { TriggerReflectionResult } from "../../agent/evolution/trigger-reflection.js";
import type { EvolutionEventRow } from "../../agent/store/index.js";
import type { TransportError } from "../transport-error.js";
import { resolveOwnedConversation, type TransportContext } from "./context.js";

/**
 * One row of `evolution.listEvents` — the adapter-facing projection of an
 * `evolution_events` row. `userId` is intentionally omitted: the column
 * is a denormalisation from `conversations.user_id` for the digest index,
 * not a value the adapter needs (the caller's identity is already
 * resolved by the Transport method). Surfacing it through the contract
 * would leak an internal storage decision.
 */
export type EvolutionEventEntry = Omit<EvolutionEventRow, "userId">;

/**
 * Outcome of `evolution.triggerReflection`. Mirrors `ObserverResult` but
 * stripped of internals the adapter doesn't need (just enough for the
 * `/reflect` reply text).
 */
export type TriggerReflectionOutcome =
  | { status: "no_session" }
  | { status: "skipped"; reason: "conversation_not_found" | "profile_not_found" | "too_short" }
  | {
      status: "processed";
      eventId: string;
      ruleChanges: {
        extracted: number;
        reinforced: number;
        promoted: number;
        retired: number;
        reset: number;
      };
      memoryCount: number;
      drained: number;
      /** Staged rows a `memory`-category rule forbade. */
      withheld: number;
      /** 1 when memory extraction was skipped for a user's memory rule the profile can't see. */
      skippedForUnseenRules: number;
      /** Staged rows left pending for a first-party fire. */
      deferredToFirstParty: number;
    };

/**
 * Evolution audit + manual trigger surface. Backs the `/learned` and
 * `/reflect` Telegram commands. Identity-checked: every method takes a
 * `platformUserHandle` resolved against `user_identities`; unknown
 * handles get `identity_rejected`. Returns `evolution_unavailable` when
 * bootstrap didn't wire a reflection trigger (test setups, future
 * deployments that disable evolution).
 *
 * `listEvents` and `getEvent` work even when the trigger is unwired —
 * they only read from `agent_store`.
 */
export interface EvolutionNamespace {
  listEvents(
    platformUserHandle: string,
    opts?: { limit?: number },
  ): Promise<Result<ReadonlyArray<EvolutionEventEntry>, TransportError>>;
  /** `ok(null)` when the row doesn't exist or belongs to another user. */
  getEvent(
    platformUserHandle: string,
    id: string,
  ): Promise<Result<EvolutionEventEntry | null, TransportError>>;
  /**
   * Synchronously run the Observer for the caller's current
   * conversation. Returns the digest the adapter renders into a single
   * Telegram reply. The autonomous idle path is untouched — this is the
   * `/reflect` manual trigger only.
   */
  triggerReflection(
    platformUserHandle: string,
    platformAddress: string,
  ): Promise<Result<TriggerReflectionOutcome, TransportError>>;
}

export function createEvolution(
  deps: TransportContext & {
    triggerReflection: ((conversationId: string) => Promise<TriggerReflectionResult>) | undefined;
  },
): EvolutionNamespace {
  const { channelId, runInTx, transportStore, agentStore, triggerReflection } = deps;
  return {
    async listEvents(platformUserHandle, opts) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const rows = await agentStore.listEvolutionEvents(tx, identity.userId, opts);
        return ok(rows.map(toEvolutionEventEntry));
      });
    },
    async getEvent(platformUserHandle, id) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const row = await agentStore.getEvolutionEvent(tx, identity.userId, id);
        return ok(row ? toEvolutionEventEntry(row) : null);
      });
    },
    async triggerReflection(platformUserHandle, platformAddress) {
      if (!triggerReflection) {
        return err({ code: "evolution_unavailable" as const });
      }
      const resolved = await resolveOwnedConversation(deps, platformUserHandle, platformAddress);
      if (resolved.kind === "identity_rejected") {
        return err({ code: "identity_rejected" as const });
      }
      if (resolved.kind === "no_session") {
        return ok({ status: "no_session" as const });
      }
      const result = await triggerReflection(resolved.conversationId);
      if (result.status === "skipped") {
        return ok({ status: "skipped" as const, reason: result.reason });
      }
      const memoryCount = result.memories.extracted;
      return ok({
        status: "processed" as const,
        eventId: result.eventId,
        ruleChanges: {
          extracted: result.corrections.extracted,
          reinforced: result.corrections.reinforced,
          promoted: result.corrections.promoted,
          retired: result.corrections.retired,
          reset: result.corrections.reset,
        },
        memoryCount,
        drained: result.drained.drained,
        withheld: result.drained.withheld,
        skippedForUnseenRules: result.memories.skippedForUnseenRules,
        deferredToFirstParty: result.drained.deferredToFirstParty,
      });
    },
  };
}

/**
 * Project an `EvolutionEventRow` onto the adapter-facing entry. Drops
 * `userId` — it's an internal denormalisation from `conversations.user_id`
 * that exists for the digest index and has no use at the adapter surface.
 */
function toEvolutionEventEntry(row: EvolutionEventRow): EvolutionEventEntry {
  return {
    id: row.id,
    conversationId: row.conversationId,
    triggeredBy: row.triggeredBy,
    payload: row.payload,
    createdAt: row.createdAt,
  };
}
