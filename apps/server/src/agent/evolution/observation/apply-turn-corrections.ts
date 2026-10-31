/**
 * `pending → applied`: one turn's corrections, written on the transaction
 * that moves the turn's row, so the writes and the move commit together and
 * a turn's corrections commit once (design/observation.md → Slice 1a → Keys).
 */

import { match } from "ts-pattern";
import type { Transactor } from "../../../db/index.js";
import type { AgentStore } from "../../store/index.js";
import {
  type ApplyCorrectionsStore,
  applyCorrections,
  type ExtractionScope,
  type TurnCorrections,
} from "../extract-corrections.js";
import type { TurnOutcome } from "./turn-outcome.js";

export interface ApplyTurnCorrectionsDeps {
  runInTx: Transactor;
  store: ApplyCorrectionsStore & Pick<AgentStore, "transitionPendingTurn">;
}

export async function applyTurnCorrections(
  deps: ApplyTurnCorrectionsDeps,
  args: {
    observationId: string;
    corrections: TurnCorrections;
    droppedNoEvidence: number;
    scope: ExtractionScope;
    activeChannelTypes: ReadonlyArray<string>;
  },
): Promise<TurnOutcome> {
  return deps.runInTx(async (tx) => {
    // First, so the row lock and the snapshot come before any rule write: a
    // concurrent apply of the same turn waits here and then retries onto
    // `applied`, writing nothing.
    const moved = await deps.store.transitionPendingTurn(tx, {
      id: args.observationId,
      to: { status: "applied" },
    });
    return match(moved)
      .returnType<Promise<TurnOutcome>>()
      .with({ kind: "stale" }, async ({ status }) => ({ kind: "taken", status }))
      .with({ kind: "transitioned" }, async () => ({
        kind: "applied",
        result: await applyCorrections(tx, args.corrections, {
          turnObservationId: args.observationId,
          scope: args.scope,
          activeChannelTypes: args.activeChannelTypes,
          store: deps.store,
        }),
        droppedNoEvidence: args.droppedNoEvidence,
      }))
      .exhaustive();
  });
}
