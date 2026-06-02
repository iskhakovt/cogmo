import type { Transactor } from "../../db/index.js";
import type { WebSessionStore } from "../store/index.js";
import { hashSessionToken } from "./token.js";

export interface DestroySessionDeps {
  runInTx: Transactor;
  webSessionStore: WebSessionStore;
}

/** Delete the session for a raw cookie token (logout). No-op if already gone. */
export async function destroySession(
  deps: DestroySessionDeps,
  args: { rawToken: string },
): Promise<void> {
  const tokenHash = hashSessionToken(args.rawToken);
  await deps.runInTx((tx) => deps.webSessionStore.deleteByTokenHash(tx, tokenHash));
}
