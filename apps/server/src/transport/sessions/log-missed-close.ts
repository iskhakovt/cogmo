import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import type { CloseSessionOutcome } from "../store/index.js";

/**
 * Report a `closeSession` that did not land — the status the row holds, or
 * no row — at `level`, with the caller's fields. Returns whether it was
 * missed. A close that lost to a swap or a rotation is not an error for any
 * caller: the session is closed either way.
 */
export function logMissedClose(
  level: "debug" | "info" | "warn",
  fields: Record<string, unknown>,
  outcome: CloseSessionOutcome,
): boolean {
  return match(outcome)
    .with({ kind: "closed" }, () => false)
    .with({ kind: "stale" }, { kind: "not_found" }, (missed) => {
      logger[level]({ ...fields, ...missed }, "session was already closed");
      return true;
    })
    .exhaustive();
}
