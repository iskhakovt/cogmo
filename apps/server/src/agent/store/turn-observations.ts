import { and, asc, eq, inArray, notExists, sql } from "drizzle-orm";
import { match } from "ts-pattern";
import type { Transaction } from "../../db/index.js";
import { inboundMessages } from "../../transport/store/schema.js";
import type { TurnExtraction } from "../evolution/observation/turn-extraction.js";
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

/** A turn the plan lists: `pending`, or `extracted` and waiting for its retain. */
export interface OpenTurn {
  observationId: string;
  cursor: string;
  /** The status the plan read: the guard of an attempt the walk records. */
  status: OpenStatus;
  /** The turn's oldest row: turns are ordered by it, and its context precedes it. */
  firstMessageId: string;
  /** Failures counted so far, as the plan read them: the guard of an attempt the walk records. */
  attempts: number;
}

/**
 * What a step reads of its row before it does anything. An `extracted` or
 * `held_extracted` row carries its stored extraction.
 */
export type TurnObservation =
  | {
      status: Exclude<ObservationStatusValue, "extracted" | "held_extracted">;
      attempts: number;
    }
  | { status: "extracted" | "held_extracted"; attempts: number; extraction: TurnExtraction };

/** Where `transitionPendingTurn` moves a `pending` row. */
export type PendingTurnTarget =
  | { status: "applied" }
  | { status: "held" }
  | { status: "skipped"; reason: Extract<ObservationSkipReasonValue, "empty"> }
  | { status: "extracted"; extraction: TurnExtraction };

/** A status the plan takes. */
export type OpenStatus = Extract<ObservationStatusValue, "pending" | "extracted">;

/** A `held_extracted` row, with the extraction its release is decided on. */
export interface HeldExtractedTurn {
  id: string;
  extraction: TurnExtraction;
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

  /** The conversation's `pending` and `extracted` turns of `phase`, oldest turn first. */
  listOpenTurns(
    tx: Transaction,
    params: { conversationId: string; phase: ObservationPhaseValue },
  ): Promise<ReadonlyArray<OpenTurn>>;

  getTurnObservation(tx: Transaction, id: string): Promise<TurnObservation | undefined>;

  /**
   * Move a `pending` row to `to`, writing the extraction when `to` carries
   * one; `stale` with the row's status when it is not `pending`.
   */
  transitionPendingTurn(
    tx: Transaction,
    params: { id: string; to: PendingTurnTarget },
  ): Promise<TurnTransition>;

  /**
   * Move an `extracted` row to `applied` or `held_extracted`, keeping its
   * extraction; `stale` with the row's status when it is not `extracted`.
   */
  transitionExtractedTurn(
    tx: Transaction,
    params: { id: string; to: "applied" | "held_extracted" },
  ): Promise<TurnTransition>;

  /** Move the conversation's `held` memories rows to `pending`. Returns how many moved. */
  releaseHeldTurns(tx: Transaction, params: { conversationId: string }): Promise<number>;

  /** The conversation's `held_extracted` memories rows, with their extractions. */
  listHeldExtractedTurns(
    tx: Transaction,
    params: { conversationId: string },
  ): Promise<ReadonlyArray<HeldExtractedTurn>>;

  /** Move the rows of `ids` that are still `held_extracted` to `extracted`. Returns how many moved. */
  releaseHeldExtractedTurns(
    tx: Transaction,
    params: { ids: ReadonlyArray<string> },
  ): Promise<number>;

  /**
   * Record a failure on a row still in `from` with `attempts` still `seen`:
   * `attempts + 1` and the failure, and `failed` when `giveUp`, the status
   * otherwise left as it is. `stale` when the row moved since.
   */
  recordTurnAttempt(
    tx: Transaction,
    params: {
      id: string;
      from: OpenStatus;
      seen: number;
      failure: TurnFailure;
      giveUp: boolean;
    },
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

  async listOpenTurns(
    tx: Transaction,
    params: { conversationId: string; phase: ObservationPhaseValue },
  ): Promise<ReadonlyArray<OpenTurn>> {
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
    const rows = await tx
      .select({
        observationId: turnObservations.id,
        cursor: turnObservations.turnCursor,
        status: turnObservations.status,
        firstMessageId: turnStarts.firstMessageId,
        attempts: turnObservations.attempts,
      })
      .from(turnObservations)
      .innerJoin(turnStarts, eq(turnStarts.cursor, turnObservations.turnCursor))
      .where(
        and(
          eq(turnObservations.conversationId, params.conversationId),
          eq(turnObservations.phase, params.phase),
          inArray(turnObservations.status, ["pending", "extracted"]),
        ),
      )
      .orderBy(asc(turnStarts.firstMessageId));
    return rows.map((r) => ({ ...r, status: openStatus(r.observationId, r.status) }));
  }

  async getTurnObservation(tx: Transaction, id: string): Promise<TurnObservation | undefined> {
    const [row] = await tx
      .select({
        status: turnObservations.status,
        attempts: turnObservations.attempts,
        extraction: turnObservations.extraction,
      })
      .from(turnObservations)
      .where(eq(turnObservations.id, id));
    if (row === undefined) return undefined;
    const { status, attempts, extraction } = row;
    return match(status)
      .returnType<TurnObservation>()
      .with("extracted", "held_extracted", (s) => {
        // `chk_turn_observations_state` requires it in these statuses.
        if (extraction === null)
          throw new Error(`turn observation ${id} is ${s} with no extraction`);
        return { status: s, attempts, extraction };
      })
      .with("pending", "held", "applied", "failed", "skipped", (s) => ({ status: s, attempts }))
      .exhaustive();
  }

  async transitionPendingTurn(
    tx: Transaction,
    params: { id: string; to: PendingTurnTarget },
  ): Promise<TurnTransition> {
    const { to } = params;
    const moved = await tx
      .update(turnObservations)
      .set({
        status: to.status,
        skipReason: to.status === "skipped" ? to.reason : null,
        ...(to.status === "extracted" && { extraction: to.extraction }),
        updatedAt: sql`now()`,
      })
      .where(and(eq(turnObservations.id, params.id), eq(turnObservations.status, "pending")))
      .returning({ id: turnObservations.id });
    if (moved.length > 0) return { kind: "transitioned" };
    return { kind: "stale", status: await this.#statusOf(tx, params.id) };
  }

  async transitionExtractedTurn(
    tx: Transaction,
    params: { id: string; to: "applied" | "held_extracted" },
  ): Promise<TurnTransition> {
    const moved = await tx
      .update(turnObservations)
      .set({ status: params.to, updatedAt: sql`now()` })
      .where(and(eq(turnObservations.id, params.id), eq(turnObservations.status, "extracted")))
      .returning({ id: turnObservations.id });
    if (moved.length > 0) return { kind: "transitioned" };
    return { kind: "stale", status: await this.#statusOf(tx, params.id) };
  }

  async releaseHeldTurns(tx: Transaction, params: { conversationId: string }): Promise<number> {
    const released = await tx
      .update(turnObservations)
      .set({ status: "pending", updatedAt: sql`now()` })
      .where(
        and(
          eq(turnObservations.conversationId, params.conversationId),
          eq(turnObservations.phase, "memories"),
          eq(turnObservations.status, "held"),
        ),
      )
      .returning({ id: turnObservations.id });
    return released.length;
  }

  async listHeldExtractedTurns(
    tx: Transaction,
    params: { conversationId: string },
  ): Promise<ReadonlyArray<HeldExtractedTurn>> {
    const rows = await tx
      .select({ id: turnObservations.id, extraction: turnObservations.extraction })
      .from(turnObservations)
      .where(
        and(
          eq(turnObservations.conversationId, params.conversationId),
          eq(turnObservations.phase, "memories"),
          eq(turnObservations.status, "held_extracted"),
        ),
      );
    return rows.map(({ id, extraction }) => {
      // `chk_turn_observations_state` requires it on a `held_extracted` row.
      if (extraction === null)
        throw new Error(`turn observation ${id} is held_extracted with no extraction`);
      return { id, extraction };
    });
  }

  async releaseHeldExtractedTurns(
    tx: Transaction,
    params: { ids: ReadonlyArray<string> },
  ): Promise<number> {
    if (params.ids.length === 0) return 0;
    const released = await tx
      .update(turnObservations)
      .set({ status: "extracted", updatedAt: sql`now()` })
      .where(
        and(
          inArray(turnObservations.id, [...params.ids]),
          eq(turnObservations.status, "held_extracted"),
        ),
      )
      .returning({ id: turnObservations.id });
    return released.length;
  }

  async recordTurnAttempt(
    tx: Transaction,
    params: {
      id: string;
      from: OpenStatus;
      seen: number;
      failure: TurnFailure;
      giveUp: boolean;
    },
  ): Promise<TurnTransition> {
    const moved = await tx
      .update(turnObservations)
      .set({
        ...(params.giveUp && { status: "failed" as const }),
        attempts: params.seen + 1,
        failureKind: params.failure.kind,
        failureMessage: params.failure.message,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(turnObservations.id, params.id),
          eq(turnObservations.status, params.from),
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

/** A status the plan's read can return; its WHERE admits no other. */
function openStatus(id: string, status: ObservationStatusValue): OpenStatus {
  return match(status)
    .returnType<OpenStatus>()
    .with("pending", "extracted", (s) => s)
    .with("held", "held_extracted", "applied", "failed", "skipped", (s) => {
      throw new Error(`turn observation ${id} is planned while ${s}`);
    })
    .exhaustive();
}
