import { and, asc, eq, notExists, sql } from "drizzle-orm";
import { match } from "ts-pattern";
import type { Transaction } from "../../db/index.js";
import { inboundMessages } from "../../transport/store/schema.js";
import {
  messages,
  type ObservationFailureKindValue,
  type ObservationPhaseValue,
  type ObservationSkipReasonValue,
  type ObservationStatusValue,
  type TurnKindValue,
  turnObservations,
} from "./schema.js";

/** An answered turn with no observation row for a phase yet. */
export interface UndiscoveredTurn {
  cursor: string;
  kind: TurnKindValue;
}

/** The row discovery inserts for a turn, as its disposition decides. */
export interface NewTurnObservation {
  cursor: string;
  kind: TurnKindValue;
  disposition: { status: "pending" } | { status: "skipped"; reason: "not_user_speech" };
}

/** A `pending` turn, as the plan lists it. */
export interface PendingTurn {
  observationId: string;
  cursor: string;
  /** The turn's oldest row: turns are ordered by it, and its context precedes it. */
  firstMessageId: string;
  /** Failures counted so far, as the plan read them: the guard of an attempt the walk records. */
  attempts: number;
}

/** What a step reads of its row before it does anything. */
export interface TurnObservation {
  status: ObservationStatusValue;
  attempts: number;
}

/** Whether a guarded transition moved the row, or the status it found instead. */
export type TurnTransition =
  | { kind: "transitioned" }
  | { kind: "stale"; status: ObservationStatusValue };

/** A turn-caused failure, as a row records it. */
export interface TurnFailure {
  kind: ObservationFailureKindValue;
  message: string;
}

export interface TurnObservationStore {
  /**
   * The conversation's answered turns (cursors at least one assistant row
   * carries) that have no row for `phase`, with each one's kind read from its
   * cursor's inbound. An anti-join, so a turn whose rows commit after a fire's
   * snapshot is found by the next fire.
   */
  listUndiscoveredTurns(
    tx: Transaction,
    params: { conversationId: string; phase: ObservationPhaseValue },
  ): Promise<ReadonlyArray<UndiscoveredTurn>>;

  /**
   * Insert one row per turn, with `attempts` 0. A row that exists already is
   * left as it is (`ON CONFLICT DO UPDATE` with a no-op SET).
   */
  insertTurnObservations(
    tx: Transaction,
    params: {
      conversationId: string;
      phase: ObservationPhaseValue;
      turns: ReadonlyArray<NewTurnObservation>;
    },
  ): Promise<void>;

  /** The conversation's `pending` turns of `phase`, oldest turn first. */
  listPendingTurns(
    tx: Transaction,
    params: { conversationId: string; phase: ObservationPhaseValue },
  ): Promise<ReadonlyArray<PendingTurn>>;

  getTurnObservation(tx: Transaction, id: string): Promise<TurnObservation | undefined>;

  /**
   * Move a `pending` row to `applied`, or to `skipped` with a reason;
   * `stale` with the row's status when it is not `pending`.
   */
  transitionPendingTurn(
    tx: Transaction,
    params: {
      id: string;
      to:
        | { status: "applied" }
        | { status: "skipped"; reason: Extract<ObservationSkipReasonValue, "empty"> };
    },
  ): Promise<TurnTransition>;

  /**
   * Record a turn-caused failure on a `pending` row whose `attempts` is still
   * `seen`: `attempts + 1`, the failure, and `to` (`pending` to retry on a
   * later fire, `failed` to give up). `stale` when the row moved since.
   */
  recordTurnAttempt(
    tx: Transaction,
    params: { id: string; seen: number; failure: TurnFailure; to: "pending" | "failed" },
  ): Promise<TurnTransition>;
}

export class DrizzleTurnObservationStore implements TurnObservationStore {
  async listUndiscoveredTurns(
    tx: Transaction,
    params: { conversationId: string; phase: ObservationPhaseValue },
  ): Promise<ReadonlyArray<UndiscoveredTurn>> {
    const rows = await tx
      .selectDistinct({ cursor: messages.lastInboundMessageId, source: inboundMessages.source })
      .from(messages)
      // Left join: the cursor is not a foreign key, and a cursor with no
      // inbound row (fixtures, a removed channel's sessions) is a chat turn.
      .leftJoin(inboundMessages, eq(inboundMessages.id, messages.lastInboundMessageId))
      .where(
        and(
          eq(messages.conversationId, params.conversationId),
          eq(messages.role, "assistant"),
          notExists(
            tx
              .select({ id: turnObservations.id })
              .from(turnObservations)
              .where(
                and(
                  eq(turnObservations.conversationId, params.conversationId),
                  eq(turnObservations.turnCursor, messages.lastInboundMessageId),
                  eq(turnObservations.phase, params.phase),
                ),
              ),
          ),
        ),
      );
    return rows.map((r) => ({
      cursor: r.cursor,
      kind: match(r.source)
        .returnType<TurnKindValue>()
        .with("scheduled", () => "scheduled")
        .with("pipeline", () => "pipeline")
        .with("user", null, () => "chat")
        .exhaustive(),
    }));
  }

  async insertTurnObservations(
    tx: Transaction,
    params: {
      conversationId: string;
      phase: ObservationPhaseValue;
      turns: ReadonlyArray<NewTurnObservation>;
    },
  ): Promise<void> {
    if (params.turns.length === 0) return;
    await tx
      .insert(turnObservations)
      .values(
        params.turns.map((t) => ({
          conversationId: params.conversationId,
          turnCursor: t.cursor,
          turnKind: t.kind,
          phase: params.phase,
          status: t.disposition.status,
          skipReason: t.disposition.status === "skipped" ? t.disposition.reason : null,
          attempts: 0,
          updatedAt: sql`now()`,
        })),
      )
      .onConflictDoUpdate({
        target: [
          turnObservations.conversationId,
          turnObservations.turnCursor,
          turnObservations.phase,
        ],
        // No-op: the key's own value, so the row is left as it is.
        set: { phase: params.phase },
      });
  }

  async listPendingTurns(
    tx: Transaction,
    params: { conversationId: string; phase: ObservationPhaseValue },
  ): Promise<ReadonlyArray<PendingTurn>> {
    // Each turn's oldest row: one per cursor, the lowest id first.
    const turnStarts = tx
      .selectDistinctOn([messages.lastInboundMessageId], {
        cursor: messages.lastInboundMessageId,
        firstMessageId: messages.id,
      })
      .from(messages)
      .where(eq(messages.conversationId, params.conversationId))
      .orderBy(messages.lastInboundMessageId, asc(messages.id))
      .as("turn_starts");
    return tx
      .select({
        observationId: turnObservations.id,
        cursor: turnObservations.turnCursor,
        firstMessageId: turnStarts.firstMessageId,
        attempts: turnObservations.attempts,
      })
      .from(turnObservations)
      .innerJoin(turnStarts, eq(turnStarts.cursor, turnObservations.turnCursor))
      .where(
        and(
          eq(turnObservations.conversationId, params.conversationId),
          eq(turnObservations.phase, params.phase),
          eq(turnObservations.status, "pending"),
        ),
      )
      .orderBy(asc(turnStarts.firstMessageId));
  }

  async getTurnObservation(tx: Transaction, id: string): Promise<TurnObservation | undefined> {
    const [row] = await tx
      .select({ status: turnObservations.status, attempts: turnObservations.attempts })
      .from(turnObservations)
      .where(eq(turnObservations.id, id));
    return row;
  }

  async transitionPendingTurn(
    tx: Transaction,
    params: {
      id: string;
      to:
        | { status: "applied" }
        | { status: "skipped"; reason: Extract<ObservationSkipReasonValue, "empty"> };
    },
  ): Promise<TurnTransition> {
    const moved = await tx
      .update(turnObservations)
      .set({
        status: params.to.status,
        skipReason: params.to.status === "skipped" ? params.to.reason : null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(turnObservations.id, params.id), eq(turnObservations.status, "pending")))
      .returning({ id: turnObservations.id });
    if (moved.length > 0) return { kind: "transitioned" };
    return { kind: "stale", status: await this.#statusOf(tx, params.id) };
  }

  async recordTurnAttempt(
    tx: Transaction,
    params: { id: string; seen: number; failure: TurnFailure; to: "pending" | "failed" },
  ): Promise<TurnTransition> {
    const moved = await tx
      .update(turnObservations)
      .set({
        status: params.to,
        attempts: params.seen + 1,
        failureKind: params.failure.kind,
        failureMessage: params.failure.message,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(turnObservations.id, params.id),
          eq(turnObservations.status, "pending"),
          eq(turnObservations.attempts, params.seen),
        ),
      )
      .returning({ id: turnObservations.id });
    if (moved.length > 0) return { kind: "transitioned" };
    return { kind: "stale", status: await this.#statusOf(tx, params.id) };
  }

  /** A row's status; the id came from a plan, so a missing row is a bug. */
  async #statusOf(tx: Transaction, id: string): Promise<ObservationStatusValue> {
    const [row] = await tx
      .select({ status: turnObservations.status })
      .from(turnObservations)
      .where(eq(turnObservations.id, id));
    if (row === undefined) throw new Error(`turn observation ${id} does not exist`);
    return row.status;
  }
}
