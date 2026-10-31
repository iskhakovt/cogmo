/**
 * Observe one pending turn's corrections: the body of one durable step,
 * owning the row's moves out of `pending` (design/observation.md →
 * Slice 1a). The row is the re-entry guard: a re-run after the apply
 * committed finds it `applied` and calls no model, and the apply's
 * transaction moves the row before it writes a rule, so a turn's corrections
 * commit exactly once.
 */

import { match } from "ts-pattern";
import { logger } from "../../../logger.js";
import type { AgentStore, PendingTurn } from "../../store/index.js";
import type { ObservationFailureKindValue, ObservationStatusValue } from "../../store/schema.js";
import {
  type ApplyCorrectionsStore,
  applyCorrections,
  type ExtractionDeps,
  type ExtractionResult,
  type ExtractionScope,
  extractTurnCorrections,
} from "../extract-corrections.js";
import { classifyTurnFailure, isTerminalTurnFailure, MAX_TURN_ATTEMPTS } from "./failure.js";
import { quotesUser, renderContext, renderTurn } from "./turns.js";

export interface ObserveTurnDeps extends Omit<ExtractionDeps, "store"> {
  store: ExtractionDeps["store"] &
    ApplyCorrectionsStore &
    Pick<
      AgentStore,
      | "getTurnObservation"
      | "findAnsweredCursorBefore"
      | "listTurnMessages"
      | "transitionPendingTurn"
      | "recordTurnAttempt"
    >;
}

export interface ObserveTurnArgs {
  conversationId: string;
  turn: PendingTurn;
  scope: ExtractionScope;
  activeChannelTypes: ReadonlyArray<string>;
}

/** What one turn's step did; small and JSON-safe, so a replay returns it as it is. */
export type TurnOutcome =
  | { kind: "applied"; result: ExtractionResult; droppedNoEvidence: number }
  | { kind: "skipped"; reason: "empty" }
  /** The row had left `pending` before the step began: a re-run, or another run's work. */
  | { kind: "done"; status: ObservationStatusValue }
  /** This step's guarded write lost to another run that moved the row first. */
  | { kind: "taken"; status: ObservationStatusValue }
  | { kind: "retryLater"; attempts: number; failure: ObservationFailureKindValue }
  | { kind: "failed"; attempts: number; failure: ObservationFailureKindValue };

export async function observeTurnCorrections(
  deps: ObserveTurnDeps,
  args: ObserveTurnArgs,
): Promise<TurnOutcome> {
  const { store } = deps;
  const { conversationId, turn } = args;
  const loaded = await deps.runInTx(async (tx) => {
    const row = await store.getTurnObservation(tx, turn.observationId);
    // The id came from this run's plan, and no code deletes the rows.
    if (row === undefined) throw new Error(`turn observation ${turn.observationId} is missing`);
    if (row.status !== "pending") return { kind: "done", status: row.status } as const;
    const previous = await store.findAnsweredCursorBefore(tx, conversationId, turn.firstMessageId);
    const cursors = previous === undefined ? [turn.cursor] : [turn.cursor, previous];
    const rows = await store.listTurnMessages(tx, conversationId, cursors);
    return { kind: "loaded", attempts: row.attempts, previous, rows } as const;
  });
  if (loaded.kind === "done") return loaded;

  const rendered = renderTurn(loaded.rows, turn.cursor);
  // Nothing a correction could quote: no model call.
  if (rendered.userText === "") {
    const moved = await deps.runInTx((tx) =>
      store.transitionPendingTurn(tx, {
        id: turn.observationId,
        to: { status: "skipped", reason: "empty" },
      }),
    );
    return match(moved)
      .returnType<TurnOutcome>()
      .with({ kind: "transitioned" }, () => ({ kind: "skipped", reason: "empty" }))
      .with({ kind: "stale" }, ({ status }) => ({ kind: "taken", status }))
      .exhaustive();
  }

  const text = {
    turn: rendered.transcript,
    context: loaded.previous === undefined ? null : renderContext(loaded.rows, loaded.previous),
  };
  let corrections: Awaited<ReturnType<typeof extractTurnCorrections>>;
  try {
    corrections = await extractTurnCorrections(text, args.scope, args.activeChannelTypes, deps);
  } catch (err) {
    const failure = classifyTurnFailure(err);
    // Not the turn's doing: the step retries it, and the row stays as it is.
    if (failure === null) throw err;
    const attempts = loaded.attempts + 1;
    const to =
      isTerminalTurnFailure(failure) || attempts >= MAX_TURN_ATTEMPTS ? "failed" : "pending";
    logger.warn(
      { err, conversationId, observationId: turn.observationId, failure: failure.kind, attempts },
      to === "failed"
        ? "observer: turn's correction extraction failed for good"
        : "observer: turn's correction extraction failed — a later fire retries it",
    );
    const moved = await deps.runInTx((tx) =>
      store.recordTurnAttempt(tx, {
        id: turn.observationId,
        seen: loaded.attempts,
        failure,
        to,
      }),
    );
    return match(moved)
      .returnType<TurnOutcome>()
      .with({ kind: "transitioned" }, () =>
        to === "failed"
          ? { kind: "failed", attempts, failure: failure.kind }
          : { kind: "retryLater", attempts, failure: failure.kind },
      )
      .with({ kind: "stale" }, ({ status }) => ({ kind: "taken", status }))
      .exhaustive();
  }

  const evidenced = corrections.items.filter((c) => quotesUser(c.evidence, rendered.userText));
  const droppedNoEvidence = corrections.items.length - evidenced.length;
  if (droppedNoEvidence > 0) {
    logger.info(
      { conversationId, observationId: turn.observationId, droppedNoEvidence },
      "observer: dropped corrections whose evidence the turn's user text doesn't hold",
    );
  }

  return deps.runInTx(async (tx) => {
    // First, so the row lock and the snapshot come before any rule write: a
    // concurrent apply of the same turn waits here and then retries onto
    // `applied`, writing nothing.
    const moved = await store.transitionPendingTurn(tx, {
      id: turn.observationId,
      to: { status: "applied" },
    });
    if (moved.kind === "stale") return { kind: "taken", status: moved.status } as const;
    const result = await applyCorrections(
      tx,
      { items: evidenced, rulesByLabel: corrections.rulesByLabel },
      {
        turnObservationId: turn.observationId,
        scope: args.scope,
        activeChannelTypes: args.activeChannelTypes,
        store,
      },
    );
    return { kind: "applied", result, droppedNoEvidence } as const;
  });
}
