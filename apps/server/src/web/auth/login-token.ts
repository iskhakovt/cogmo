import { timingSafeEqual } from "node:crypto";
import { deriveMasterKey, parseMasterKey } from "../../secrets/encryption.js";

/**
 * HKDF purpose for the web bootstrap login token. Bump the version suffix to
 * rotate the token (invalidates the old one without touching the master key,
 * since HKDF outputs under distinct `info` are independent). Keep this as the
 * single source of truth for both `deriveWebLoginToken` and the `web-token` CLI.
 */
export const WEB_LOGIN_TOKEN_PURPOSE = "cogmo/web-login-token/v1";

/**
 * Derive the bootstrap login token from the master key. Deterministic, stored
 * nowhere — the gate recomputes it and constant-time-compares the presented
 * value. base64url so it is cookie/URL/clipboard safe.
 */
export function deriveWebLoginToken(masterKeyBase64: string): string {
  const derived = deriveMasterKey(parseMasterKey(masterKeyBase64), WEB_LOGIN_TOKEN_PURPOSE);
  return Buffer.from(derived).toString("base64url");
}

/**
 * Constant-time compare of a presented token against the derived one. Length is
 * guarded before `timingSafeEqual` (which throws on length mismatch); a dummy
 * compare on mismatch keeps the timing profile flat.
 */
export function verifyWebLoginToken(candidate: string, derived: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(derived);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
