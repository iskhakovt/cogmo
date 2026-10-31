/**
 * Discovery and the plan: a row for every answered turn the corrections
 * phase hasn't seen, then the pending turns a fire works through, oldest
 * first (design/observation.md → Slice 1a).
 */

import { match } from "ts-pattern";
import type { Transactor } from "../../../db/index.js";
import type { AgentStore, NewTurnObservation, PendingTurn } from "../../store/index.js";
import type { TurnKindValue } from "../../store/schema.js";

export interface DiscoverTurnsDeps {
  runInTx: Transactor;
  store: Pick<AgentStore, "listUndiscoveredTurns" | "insertTurnObservations" | "listPendingTurns">;
}

/** What one fire observes, and what it leaves for a later one. */
export interface TurnPlan {
  /** Up to the fire's cap of pending turns, oldest first. */
  turns: ReadonlyArray<PendingTurn>;
  /** Pending turns beyond the cap. */
  remaining: number;
  /** Turns discovery skipped as `not_user_speech` this fire. */
  notUserSpeech: number;
}

/**
 * Insert the undiscovered turns' rows and read the plan, in one transaction.
 * Idempotent: a re-run finds the rows and plans from them, and a concurrent
 * discovery's insert after this snapshot raises `40001`, which the transactor
 * retries onto the rows it wrote.
 */
export async function discoverTurns(
  deps: DiscoverTurnsDeps,
  args: { conversationId: string; limit: number },
): Promise<TurnPlan> {
  const { conversationId } = args;
  const phase = "corrections";
  return deps.runInTx(async (tx) => {
    const found = await deps.store.listUndiscoveredTurns(tx, { conversationId, phase });
    const turns: ReadonlyArray<NewTurnObservation> = found.map((t) => ({
      ...t,
      disposition: dispositionOf(t.kind),
    }));
    await deps.store.insertTurnObservations(tx, { conversationId, phase, turns });
    const pending = await deps.store.listPendingTurns(tx, { conversationId, phase });
    return {
      turns: pending.slice(0, args.limit),
      remaining: Math.max(0, pending.length - args.limit),
      notUserSpeech: turns.filter((t) => t.disposition.status === "skipped").length,
    };
  });
}

/**
 * A chat turn's user row is the user's speech. A scheduled or pipeline turn's
 * is a task prompt: its corrections are skipped, and the user's reaction to
 * its reply arrives in the next chat turn, which carries it as context.
 */
function dispositionOf(kind: TurnKindValue): NewTurnObservation["disposition"] {
  return match(kind)
    .returnType<NewTurnObservation["disposition"]>()
    .with("chat", () => ({ status: "pending" }))
    .with("scheduled", "pipeline", () => ({ status: "skipped", reason: "not_user_speech" }))
    .exhaustive();
}
