import type { Transactor } from "../../db/index.js";
import {
  type LoadTurnHistoryDeps,
  loadTurnHistory,
  type TurnHistory,
  TurnRowMissingError,
} from "../conversation/load-turn-history.js";
import { asNonRetriable } from "../turn-step-runner.js";
import type { TurnSteps } from "./turn-steps.js";

export interface TurnTranscript {
  /** The compacted view with stored turn contexts. */
  history: TurnHistory;
  /** The turn's own user row, found by its inbound cursor. */
  turn: { id: string; createdAt: string };
}

/**
 * The compacted view with stored turn contexts, plus the turn's own row found
 * by its inbound cursor (see `loadTurnHistory`). In a step so a `/compact`
 * landing mid-run can't shift the history between invocations.
 *
 * Step: `load-turn-transcript`.
 */
export async function loadTurnTranscript(
  step: TurnSteps,
  deps: { runInTx: Transactor; agentStore: LoadTurnHistoryDeps["agentStore"] },
  args: { conversationId: string; turnInboundId: string },
): Promise<TurnTranscript> {
  const history = await step.run("load-turn-transcript", async () => {
    try {
      return await loadTurnHistory(deps, args);
    } catch (err) {
      if (err instanceof TurnRowMissingError) throw asNonRetriable(err);
      throw err;
    }
  });
  const turn = history.turn;
  if (turn === null) throw new Error("load-turn-transcript returned no turn row");
  return { history, turn };
}
