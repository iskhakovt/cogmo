import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import type { WebSessionStore } from "../store/index.js";
import { hashSessionToken } from "./token.js";

export interface ResolveSessionDeps {
  runInTx: Transactor;
  webSessionStore: WebSessionStore;
}

/**
 * Skip the `last_used_at` bump unless the row is at least this stale.
 * `last_used_at` is coarse bookkeeping (idle reclaim, an "active sessions" view)
 * — a minute of resolution is plenty, and throttling collapses the steady-state
 * write volume from a dashboard that fires many reads at once.
 */
const TOUCH_THROTTLE_MS = 60_000;

/**
 * Resolve a raw cookie token to its owner: hash, look up an unexpired row.
 *
 * The lookup is the gate — it commits in its own transaction, so auth never
 * fails on bookkeeping. The `last_used_at` bump is best-effort and throttled,
 * fired-and-forgotten in a separate transaction: N concurrent reads updating one
 * row under REPEATABLE READ would otherwise contend (40001) and, with no
 * outer HTTP retry budget, surface as a 500. Degrading to a stale timestamp is
 * the right trade for pure bookkeeping.
 */
export async function resolveSession(
  deps: ResolveSessionDeps,
  args: { rawToken: string; now: Date },
): Promise<{ userId: string } | null> {
  const tokenHash = hashSessionToken(args.rawToken);
  const row = await deps.runInTx((tx) =>
    deps.webSessionStore.findValidByTokenHash(tx, tokenHash, args.now),
  );
  if (!row) return null;

  if (args.now.getTime() - row.lastUsedAt.getTime() >= TOUCH_THROTTLE_MS) {
    void deps
      .runInTx((tx) => deps.webSessionStore.touch(tx, row.id, args.now))
      .catch((err) => logger.debug({ err, sessionId: row.id }, "web session touch failed"));
  }
  return { userId: row.userId };
}
