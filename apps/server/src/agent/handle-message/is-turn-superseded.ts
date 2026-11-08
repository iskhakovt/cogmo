import type { Transactor } from "../../db/index.js";
import type { AgentStore } from "../store/index.js";

export interface IsTurnSupersededDeps {
  runInTx: Transactor;
  agentStore: Pick<AgentStore, "isCursorAnswered" | "isCursorRebatched">;
}

export interface IsTurnSupersededArgs {
  conversationId: string;
  /** The batch's last inbound: the cursor the turn's rows are written with. */
  cursor: string;
  /** The reply admission found (`last-assistant`), or null before the first. */
  afterMessageId: string | null;
}

/**
 * Whether another reply owns the turn's inbounds, so `persist-new-messages`
 * would refuse the turn's own: another run of the batch persisted a reply on
 * its cursor, or a later turn row re-batched it. The turn asks before each of
 * its LLM iterations, inside the iteration's step, and stops when this holds
 * (design/crash-recovery.md → Late replies).
 *
 * The turn's own reply can't be the one found: its persist step runs after
 * every iteration step has stored its result, so no iteration step body runs
 * once the reply has committed.
 */
export async function isTurnSuperseded(
  deps: IsTurnSupersededDeps,
  args: IsTurnSupersededArgs,
): Promise<boolean> {
  return deps.runInTx(
    async (tx) =>
      (await deps.agentStore.isCursorAnswered(tx, args)) ||
      (await deps.agentStore.isCursorRebatched(tx, args)),
  );
}
