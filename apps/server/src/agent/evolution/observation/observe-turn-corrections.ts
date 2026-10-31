/**
 * Observe one pending turn's corrections: the body of one durable step
 * (design/observation.md → Slice 1a). The row is the re-entry guard: a
 * re-run after the apply committed finds it `applied` and calls no model.
 * Each move out of `pending` is its own use case: `applyTurnCorrections`,
 * `skipEmptyTurn` and `recordTurnAttempt`.
 */

import { match } from "ts-pattern";
import { logger } from "../../../logger.js";
import type { AgentStore, PendingTurn, TurnMessage } from "../../store/index.js";
import {
  type ApplyCorrectionsStore,
  type ExtractionDeps,
  type ExtractionScope,
  extractTurnCorrections,
  type TurnCorrections,
} from "../extract-corrections.js";
import { applyTurnCorrections } from "./apply-turn-corrections.js";
import { classifyTurnFailure, ExtractionUnavailableError } from "./failure.js";
import { recordTurnAttempt } from "./record-turn-attempt.js";
import { skipEmptyTurn } from "./skip-empty-turn.js";
import type { TurnOutcome } from "./turn-outcome.js";
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

/** A pending turn's rows, read with the count its attempt is guarded on. */
interface LoadedTurn {
  kind: "loaded";
  attempts: number;
  /** The cursor of the turn answered before this one: the context. */
  previous: string | undefined;
  rows: ReadonlyArray<TurnMessage>;
}

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
    return match(row.status)
      .returnType<Promise<LoadedTurn | Extract<TurnOutcome, { kind: "done" }>>>()
      .with("applied", "failed", "skipped", async (status) => ({ kind: "done", status }))
      .with("pending", async () => {
        const previous = await store.findAnsweredCursorBefore(
          tx,
          conversationId,
          turn.firstMessageId,
        );
        const cursors = previous === undefined ? [turn.cursor] : [turn.cursor, previous];
        const rows = await store.listTurnMessages(tx, conversationId, cursors);
        return { kind: "loaded", attempts: row.attempts, previous, rows };
      })
      .exhaustive();
  });
  return match(loaded)
    .returnType<Promise<TurnOutcome>>()
    .with({ kind: "done" }, async (done) => done)
    .with({ kind: "loaded" }, (pending) => observeLoaded(deps, args, pending))
    .exhaustive();
}

async function observeLoaded(
  deps: ObserveTurnDeps,
  args: ObserveTurnArgs,
  loaded: LoadedTurn,
): Promise<TurnOutcome> {
  const { conversationId, turn } = args;
  const observationId = turn.observationId;
  const rendered = renderTurn(loaded.rows, turn.cursor);
  // Nothing a correction could quote: no model call.
  if (rendered.userText === "") return skipEmptyTurn(deps, { observationId });

  const text = {
    turn: rendered.transcript,
    context: loaded.previous === undefined ? null : renderContext(loaded.rows, loaded.previous),
  };
  let corrections: TurnCorrections;
  try {
    corrections = await extractTurnCorrections(text, args.scope, args.activeChannelTypes, deps);
  } catch (err) {
    const failure = classifyTurnFailure(err);
    // Not the turn's doing: the step retries it, and the row stays as it is.
    if (failure === null) throw new ExtractionUnavailableError(err);
    logger.warn({ err, conversationId, observationId }, "observer: turn's extraction failed");
    return recordTurnAttempt(deps, { observationId, seen: loaded.attempts, failure });
  }

  const evidenced = corrections.items.filter((c) => quotesUser(c.evidence, rendered.userText));
  const droppedNoEvidence = corrections.items.length - evidenced.length;
  if (droppedNoEvidence > 0) {
    logger.info(
      { conversationId, observationId, droppedNoEvidence },
      "observer: dropped corrections whose evidence the turn's user text doesn't hold",
    );
  }
  return applyTurnCorrections(deps, {
    observationId,
    corrections: { items: evidenced, rulesByLabel: corrections.rulesByLabel },
    droppedNoEvidence,
    scope: args.scope,
    activeChannelTypes: args.activeChannelTypes,
  });
}
