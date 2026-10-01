import { and, desc, eq } from "drizzle-orm";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import type { EvolutionEventPayload } from "../evolution/event-schema.js";
import { type EvolutionTriggerValue, evolutionEvents } from "./schema.js";

/**
 * One persisted row from `evolution_events`. `payload` carries the validated
 * `EvolutionEventPayloadSchema` shape (the `ObserverResult` projection).
 */
export interface EvolutionEventRow {
  id: string;
  conversationId: string;
  userId: string;
  triggeredBy: EvolutionTriggerValue;
  payload: EvolutionEventPayload;
  createdAt: Date;
}

/** The `evolution_events` rows: the append-only audit log of processed Observer fires. */
export interface EvolutionEventStore {
  /**
   * Append one `evolution_events` row capturing a processed Observer fire.
   * Called by the Observer (autonomous + manual). `userId` is resolved by
   * the caller from the conversation — the denormalised column lets the
   * `/learned` digest scan by user without joining `conversations`.
   */
  recordEvolutionEvent(
    tx: Transaction,
    params: {
      conversationId: string;
      userId: string;
      triggeredBy: EvolutionTriggerValue;
      payload: EvolutionEventPayload;
    },
  ): Promise<{ id: string }>;

  /**
   * List evolution events for a user, newest-first. Used by the `/learned`
   * digest. `limit` caps the result; default 10 — the Telegram digest
   * shows at most ten rows and any more would scroll off screen anyway.
   */
  listEvolutionEvents(
    tx: Transaction,
    userId: string,
    opts?: { limit?: number },
  ): Promise<ReadonlyArray<EvolutionEventRow>>;

  /**
   * Load a single evolution event by id. Returns undefined when not found
   * OR when the row belongs to another user — same probing-protection
   * shape as `scheduling.*` and `/repair`. Caller passes their resolved
   * `userId` and surfaces undefined as "not found" without leaking the
   * existence of another user's rows.
   */
  getEvolutionEvent(
    tx: Transaction,
    userId: string,
    id: string,
  ): Promise<EvolutionEventRow | undefined>;
}

export class DrizzleEvolutionEventStore implements EvolutionEventStore {
  async recordEvolutionEvent(
    tx: Transaction,
    params: {
      conversationId: string;
      userId: string;
      triggeredBy: EvolutionTriggerValue;
      payload: EvolutionEventPayload;
    },
  ): Promise<{ id: string }> {
    return single(
      await tx
        .insert(evolutionEvents)
        .values({
          conversationId: params.conversationId,
          userId: params.userId,
          triggeredBy: params.triggeredBy,
          payload: params.payload,
        })
        .returning({ id: evolutionEvents.id }),
    );
  }

  async listEvolutionEvents(
    tx: Transaction,
    userId: string,
    opts?: { limit?: number },
  ): Promise<ReadonlyArray<EvolutionEventRow>> {
    const limit = opts?.limit ?? 10;
    return tx
      .select()
      .from(evolutionEvents)
      .where(eq(evolutionEvents.userId, userId))
      .orderBy(desc(evolutionEvents.createdAt))
      .limit(limit);
  }

  async getEvolutionEvent(
    tx: Transaction,
    userId: string,
    id: string,
  ): Promise<EvolutionEventRow | undefined> {
    const rows = await tx
      .select()
      .from(evolutionEvents)
      .where(and(eq(evolutionEvents.id, id), eq(evolutionEvents.userId, userId)))
      .limit(1);
    return rows[0];
  }
}
