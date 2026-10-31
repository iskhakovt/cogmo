/**
 * `pending → skipped (empty)`: a turn whose turn row holds no user text has
 * nothing a correction could quote, so it is skipped before any model call
 * (design/observation.md → Slice 1a → Transitions).
 */

import { match } from "ts-pattern";
import type { Transactor } from "../../../db/index.js";
import type { AgentStore } from "../../store/index.js";
import type { TurnOutcome } from "./turn-outcome.js";

export interface SkipEmptyTurnDeps {
  runInTx: Transactor;
  store: Pick<AgentStore, "transitionPendingTurn">;
}

export async function skipEmptyTurn(
  deps: SkipEmptyTurnDeps,
  args: { observationId: string },
): Promise<TurnOutcome> {
  const moved = await deps.runInTx((tx) =>
    deps.store.transitionPendingTurn(tx, {
      id: args.observationId,
      to: { status: "skipped", reason: "empty" },
    }),
  );
  return match(moved)
    .returnType<TurnOutcome>()
    .with({ kind: "transitioned" }, () => ({ kind: "skipped", reason: "empty" }))
    .with({ kind: "stale" }, ({ status }) => ({ kind: "taken", status }))
    .exhaustive();
}
