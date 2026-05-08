/**
 * Daytona managed-sandbox auth — the secret-store key shared by the
 * runtime read path (`src/index.ts`), the setup wizard, and the
 * non-interactive bootstrap.
 *
 * Mirrors the pattern from `src/agent/coding/auth.ts`: the constant lives
 * outside the consumers so a key rename can't get out of sync between the
 * write-side (setup) and the read-side (boot). No runtime loader yet —
 * `bootstrap()` reads the secret directly because it's just one record
 * with no derivation.
 */

export const DAYTONA_API_KEY_SECRET = "daytona_api_key";

export const DAYTONA_API_KEY_SECRET_DESCRIPTION =
  "Daytona managed-sandbox API key (https://app.daytona.io → API Keys)";
