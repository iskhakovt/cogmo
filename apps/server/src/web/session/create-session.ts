import type { Transactor } from "../../db/index.js";
import type { WebSessionStore } from "../store/index.js";
import { newSessionToken } from "./token.js";

export interface CreateSessionDeps {
  runInTx: Transactor;
  webSessionStore: WebSessionStore;
  /** Constant-time compare of the presented bootstrap token to the derived one. */
  verifyLoginToken: (candidate: string) => boolean;
  /** Owner user id the session belongs to (the web channel's single owner). */
  ownerUserId: string;
  ttlDays: number;
}

export interface CreateSessionResult {
  rawToken: string;
  maxAgeSeconds: number;
}

/**
 * Verify the bootstrap token and mint a session. Returns the raw cookie token
 * (only its hash is persisted) and the cookie max-age, or null when the token
 * is wrong.
 */
export async function createSession(
  deps: CreateSessionDeps,
  args: { token: string; now: Date },
): Promise<CreateSessionResult | null> {
  if (!deps.verifyLoginToken(args.token)) return null;

  const { rawToken, tokenHash } = newSessionToken();
  const maxAgeSeconds = deps.ttlDays * 24 * 60 * 60;
  const expiresAt = new Date(args.now.getTime() + maxAgeSeconds * 1000);

  await deps.runInTx((tx) =>
    deps.webSessionStore.create(tx, { tokenHash, userId: deps.ownerUserId, expiresAt }),
  );
  return { rawToken, maxAgeSeconds };
}
