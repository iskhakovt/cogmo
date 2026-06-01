import { createHash, randomBytes } from "node:crypto";

/** Mint a fresh opaque session token (cookie value) + its stored SHA-256 hash. */
export function newSessionToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString("base64url");
  return { rawToken, tokenHash: hashSessionToken(rawToken) };
}

/** SHA-256 (hex) of a raw session token — what `web_sessions` stores. */
export function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}
