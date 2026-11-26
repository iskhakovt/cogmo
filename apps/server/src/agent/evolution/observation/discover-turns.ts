/**
 * Discovery and the plan: a row for every answered turn a phase hasn't seen,
 * then the turns a fire works through, oldest first (design/observation.md →
 * Slices 1a and 2a).
 */

import { match } from "ts-pattern";
import type { Transactor } from "../../../db/index.js";
import type { AgentStore, NewTurnObservation, OpenTurn } from "../../store/index.js";
import type { ObservationPhaseValue, TurnKindValue } from "../../store/schema.js";

export interface DiscoverTurnsDeps {
  runInTx: Transactor;
  store: Pick<AgentStore, "listUndiscoveredTurns" | "insertTurnObservations" | "listOpenTurns">;
}

/** What one fire observes, and what it leaves for a later one. */
export interface TurnPlan {
  /** Up to the fire's cap of `pending` and `extracted` turns, oldest first. */
  turns: ReadonlyArray<OpenTurn>;
  /** Such turns beyond the cap. */
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
  args: { conversationId: string; phase: ObservationPhaseValue; limit: number },
): Promise<TurnPlan> {
  const { conversationId, phase } = args;
  return deps.runInTx(async (tx) => {
    const found = await deps.store.listUndiscoveredTurns(tx, { conversationId, phase });
    const turns: ReadonlyArray<NewTurnObservation> = found.map((t) => ({
      ...t,
      disposition: dispositionOf(phase, t.kind),
    }));
    await deps.store.insertTurnObservations(tx, { conversationId, phase, turns });
    const open = await deps.store.listOpenTurns(tx, { conversationId, phase });
    return {
      turns: open.slice(0, args.limit),
      remaining: Math.max(0, open.length - args.limit),
      notUserSpeech: turns.filter((t) => t.disposition.status === "skipped").length,
    };
  });
}

/**
 * A chat turn's user row is the user's speech. A scheduled or pipeline turn's
 * is a task prompt: its corrections are skipped, and the user's reaction to
 * its reply arrives in the next chat turn, which carries it as context. Every
 * kind of turn is observed for memories.
 */
function dispositionOf(
  phase: ObservationPhaseValue,
  kind: TurnKindValue,
): NewTurnObservation["disposition"] {
  return match(phase)
    .returnType<NewTurnObservation["disposition"]>()
    .with("memories", () => ({ status: "pending" }))
    .with("corrections", () =>
      match(kind)
        .returnType<NewTurnObservation["disposition"]>()
        .with("chat", () => ({ status: "pending" }))
        .with("scheduled", "pipeline", () => ({ status: "skipped", reason: "not_user_speech" }))
        .exhaustive(),
    )
    .exhaustive();
}
