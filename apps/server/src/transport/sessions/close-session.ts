import { match } from "ts-pattern";
import type { Transaction } from "../../db/index.js";
import type { CloseSessionOutcome, TransportStore } from "../store/index.js";
import type { ChannelSessionStatus } from "../store/schema.js";

export interface CloseSessionDeps {
  transportStore: Pick<TransportStore, "closeSession">;
}

/**
 * The `close` transition (design/transport/sessions.md → Lifecycle):
 * `active → closed` for one session, conditional on it still being active.
 */
export async function closeSession(
  deps: CloseSessionDeps,
  tx: Transaction,
  sessionId: string,
): Promise<CloseSessionOutcome> {
  return deps.transportStore.closeSession(tx, sessionId);
}

/**
 * What a close found when it did not land: the status the row holds, or no
 * row. `undefined` when it closed the session. A close that lost to a swap
 * or a rotation is not an error for any caller; this is what they log.
 */
export function missedClose(
  outcome: CloseSessionOutcome,
): { kind: "stale"; status: ChannelSessionStatus } | { kind: "not_found" } | undefined {
  return match(outcome)
    .with({ kind: "closed" }, () => undefined)
    .with({ kind: "stale" }, (missed) => missed)
    .with({ kind: "not_found" }, (missed) => missed)
    .exhaustive();
}
