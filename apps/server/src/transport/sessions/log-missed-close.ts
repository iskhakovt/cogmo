import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import type { CloseSessionOutcome } from "../store/index.js";

/**
 * Report a `closeSession` that did not land — the status the row holds, or
 * no row — at debug, with the caller's fields. A close that lost to a swap or
 * a rotation is not an error for the caller: the session is closed either
 * way, which is all a stream disconnect wants.
 */
export function logMissedClose(
  fields: Record<string, unknown>,
  outcome: CloseSessionOutcome,
): void {
  match(outcome)
    .with({ kind: "closed" }, () => undefined)
    .with({ kind: "stale" }, { kind: "not_found" }, (missed) =>
      logger.debug({ ...fields, ...missed }, "session was already closed"),
    )
    .exhaustive();
}
