/**
 * `pending → skipped (empty)`: a turn with nothing an item could quote (no
 * user text for corrections, no rendered text for memories) is skipped before
 * any model call (design/observation.md → Slice 1a → Transitions, Slice 2a).
 */

import { match } from "ts-pattern";
import type { Transactor } from "../../../db/index.js";
import type { AgentStore } from "../../store/index.js";
import type { TurnSettled } from "./turn-outcome.js";

export interface SkipEmptyTurnDeps {
  runInTx: Transactor;
  store: Pick<AgentStore, "transitionPendingTurn">;
}

export async function skipEmptyTurn(
  deps: SkipEmptyTurnDeps,
  args: { observationId: string },
): Promise<TurnSettled> {
  const moved = await deps.runInTx((tx) =>
    deps.store.transitionPendingTurn(tx, {
      id: args.observationId,
      to: { status: "skipped", reason: "empty" },
    }),
  );
  return match(moved)
    .returnType<TurnSettled>()
    .with({ kind: "transitioned" }, () => ({ kind: "skipped", reason: "empty" }))
    .with({ kind: "stale" }, ({ status }) => ({ kind: "taken", status }))
    .exhaustive();
}
