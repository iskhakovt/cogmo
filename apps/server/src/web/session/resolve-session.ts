import type { Transactor } from "../../db/index.js";
import type { WebSessionStore } from "../store/index.js";
import { hashSessionToken } from "./token.js";

export interface ResolveSessionDeps {
  runInTx: Transactor;
  webSessionStore: WebSessionStore;
}

/**
 * Resolve a raw cookie token to its owner: hash, look up an unexpired row,
 * bump `last_used_at`. Returns null on miss or expiry.
 */
export async function resolveSession(
  deps: ResolveSessionDeps,
  args: { rawToken: string; now: Date },
): Promise<{ userId: string } | null> {
  const tokenHash = hashSessionToken(args.rawToken);
  return deps.runInTx(async (tx) => {
    const row = await deps.webSessionStore.findValidByTokenHash(tx, tokenHash, args.now);
    if (!row) return null;
    await deps.webSessionStore.touch(tx, row.id, args.now);
    return { userId: row.userId };
  });
}
