/**
 * `pending → extracted`: store a turn's facts on its row before any of them is
 * retained, so a re-run re-sends the same items under the same positions and
 * calls no model (design/observation.md → Slice 2a → Keys).
 */

import { match } from "ts-pattern";
import type { Transactor } from "../../../db/index.js";
import type { AgentStore, TurnTransition } from "../../store/index.js";
import type { TurnExtraction } from "./turn-extraction.js";

export interface StoreTurnExtractionDeps {
  runInTx: Transactor;
  store: Pick<AgentStore, "transitionPendingTurn">;
}

/** Whether this step's extraction is the turn's, or another run moved the row first. */
export type StoredExtraction = { kind: "stored" } | Extract<TurnTransition, { kind: "stale" }>;

export async function storeTurnExtraction(
  deps: StoreTurnExtractionDeps,
  args: { observationId: string; extraction: TurnExtraction },
): Promise<StoredExtraction> {
  const moved = await deps.runInTx((tx) =>
    deps.store.transitionPendingTurn(tx, {
      id: args.observationId,
      to: { status: "extracted", extraction: args.extraction },
    }),
  );
  return match(moved)
    .returnType<StoredExtraction>()
    .with({ kind: "transitioned" }, () => ({ kind: "stored" }))
    .with({ kind: "stale" }, (stale) => stale)
    .exhaustive();
}
