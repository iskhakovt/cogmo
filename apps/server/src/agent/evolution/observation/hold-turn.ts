/**
 * `pending → held`: a fire whose profile is bound by a memory rule it can't
 * see holds the turn before any model call (design/observation.md → Slice 2a
 * → Held).
 */

import { match } from "ts-pattern";
import type { Transactor } from "../../../db/index.js";
import type { AgentStore } from "../../store/index.js";
import type { MemoryTurnOutcome } from "./turn-outcome.js";

export interface HoldTurnDeps {
  runInTx: Transactor;
  store: Pick<AgentStore, "transitionPendingTurn">;
}

export async function holdTurn(
  deps: HoldTurnDeps,
  args: { observationId: string },
): Promise<MemoryTurnOutcome> {
  const moved = await deps.runInTx((tx) =>
    deps.store.transitionPendingTurn(tx, { id: args.observationId, to: { status: "held" } }),
  );
  return match(moved)
    .returnType<MemoryTurnOutcome>()
    .with({ kind: "transitioned" }, () => ({ kind: "held" }))
    .with({ kind: "stale" }, ({ status }) => ({ kind: "taken", status }))
    .exhaustive();
}
