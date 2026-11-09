import { createHash, randomBytes } from "node:crypto";

/** Mint a fresh connector bearer token and the SHA-256 hash `connectors` stores. */
export function newConnectorToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString("base64url");
  return { rawToken, tokenHash: hashConnectorToken(rawToken) };
}

/** SHA-256 (hex) of a raw connector token: what `connectors.token_hash` holds. */
export function hashConnectorToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}
