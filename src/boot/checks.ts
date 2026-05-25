/**
 * Boot-time dependency checks.
 *
 * Each function probes one external dependency that production code paths
 * silently assume is in place. Run from `bootstrap()` in `src/index.ts`
 * after the dependency has been constructed but before the orchestrator
 * starts taking traffic — fail fast at boot beats failing mid-turn after
 * the user has already sent a message.
 *
 * Policy:
 * - **Hard fail (throw `BootCheckError`):** deterministic, deployment-shaped
 *   problems that won't self-heal — missing extension, missing bucket,
 *   server version outside the supported range. Operator action required.
 * - **Soft fail (`logger.warn`, return):** transient network blips. The
 *   relevant tools surface their own errors at request time; aborting
 *   `serve` over a one-off Hindsight blip is worse UX than logging loud
 *   and degrading gracefully on the affected surface.
 */

import { constants as fsConstants, readFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { HeadBucketCommand, type S3Client } from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import semver from "semver";
import { z } from "zod";
import type { Database } from "../db/index.js";
import { logger } from "../logger.js";
import type { HindsightMemoryProvider } from "../memory/hindsight.js";

export class BootCheckError extends Error {
  override readonly name = "BootCheckError";
}

/**
 * The Hindsight server version this codebase has been validated against,
 * as a node-semver range string (e.g. `">=0.6.0 <0.7.0"`,
 * `"^0.6.0"`). Stored next to the npm client pin in `package.json`
 * under `cogmo.hindsightCompat`.
 *
 * Semantic wildcards are rejected — `*`, `x`, `X`, the empty string,
 * `>=0.0.0`, `>=0.0.0-0`, etc. Any pin where every published Hindsight
 * version would satisfy the range makes the version check a no-op,
 * which is almost certainly a mistake.
 *
 * Detection uses `semver.subset("*", range)`: if the all-versions range
 * (`*`) is a subset of the pin, the pin accepts everything. Catches both
 * literal `"*"` (which `validRange` canonicalises to `"*"`) and the
 * less-obvious cases like `>=0.0.0-0` (which `validRange` leaves alone
 * but which still semantically matches every version).
 */
export const HindsightCompatSchema = z
  .string()
  .min(1, { message: "must not be empty" })
  .refine((s) => semver.validRange(s) !== null, {
    message: "must be a valid node-semver range",
  })
  .refine((s) => !semver.subset("*", semver.validRange(s) ?? ""), {
    message: "wildcard ranges (matches every version) are rejected — pin a real range",
  });
export type HindsightCompat = z.infer<typeof HindsightCompatSchema>;

const PackageJsonSchema = z.object({
  cogmo: z.object({
    hindsightCompat: HindsightCompatSchema,
  }),
});

/**
 * Read the Hindsight server compatibility range from `package.json`'s
 * custom `cogmo.hindsightCompat` field. The range is intentionally
 * deployment metadata, not a code constant — Renovate / a release
 * engineer can bump it from upstream releases without touching TS.
 */
export function loadHindsightCompat(): HindsightCompat {
  // Read from cwd, not relative to `import.meta.url`. tsup bundles
  // `src/boot/checks.ts` into a top-level chunk in `dist/`, so the
  // src→pkg depth (`../../`) doesn't survive the build. Bootstrap
  // already assumes cwd is the project root (cf. `./migrations` in
  // `migrate(...)`); this stays consistent with that assumption.
  const raw = readFileSync(resolve(process.cwd(), "package.json"), "utf-8");
  return PackageJsonSchema.parse(JSON.parse(raw)).cogmo.hindsightCompat;
}

/**
 * Verify the `uuidv7()` SQL function is callable. Schema PKs depend on
 * it as their `DEFAULT`, so a missing function turns every INSERT into
 * `function uuidv7() does not exist` mid-turn. `scripts/init-db.sql`
 * installs it (native on PG18+, plpgsql fallback for older versions);
 * this check is the safety net for deployments that skipped that step.
 */
export async function checkUuidv7(db: Database): Promise<void> {
  try {
    await db.execute(sql`SELECT uuidv7()`);
  } catch (err) {
    throw new BootCheckError(
      `uuidv7() not callable — required for table primary keys. ` +
        `Run scripts/init-db.sql against the database, or upgrade to PG18+ ` +
        `(native uuidv7). Underlying error: ${stringifyError(err)}`,
    );
  }
}

/**
 * Verify the configured S3 bucket exists and credentials are valid.
 * `HeadBucket` is the cheapest probe — no list, no read, no write.
 */
export async function checkS3Bucket(s3: S3Client, bucket: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    throw new BootCheckError(
      `S3 bucket "${bucket}" not reachable. Check S3_ENDPOINT, ` +
        `S3_ACCESS_KEY/S3_SECRET_KEY, S3_REGION, and that the bucket exists. ` +
        `Underlying error: ${stringifyError(err)}`,
    );
  }
}

/**
 * Probe the Hindsight server's `/version` and enforce the compat range
 * pinned in package.json.
 *
 * Hard fail when the server reports a version outside the range — that's
 * a real compatibility problem (e.g. against 0.5.x the async `retainBatch`
 * path silently drops items past the first), and the operator needs to
 * fix the deployment, not retry.
 *
 * Soft fail when `/version` itself can't be reached — Hindsight could
 * be restarting during a deploy, and killing `serve` over that is
 * worse than letting memory tools fail individually at request time.
 */
export async function checkHindsightVersion(
  memory: HindsightMemoryProvider,
  range: HindsightCompat,
): Promise<void> {
  let actual: string;
  try {
    actual = await memory.getServerVersion();
  } catch (err) {
    logger.warn(
      { err: stringifyError(err), range },
      "hindsight /version probe failed at boot — skipping version check; memory tools will surface errors at request time if the server stays unreachable",
    );
    return;
  }
  // Always coerce — strips prerelease (`0.6.0-rc.1`) and build (`0.6.0+sha`)
  // suffixes down to the stable triple. node-semver's range matching is
  // famously strict about prereleases (a prerelease only satisfies a
  // range if some comparator in that range explicitly mentions one),
  // and we care about wire-compat at the major/minor/patch level, not
  // about whether someone shipped a stable build.
  const coerced = semver.coerce(actual)?.version;
  if (coerced === undefined) {
    throw new BootCheckError(
      `Hindsight server reported an unparseable version: ${JSON.stringify(actual)}`,
    );
  }
  if (!semver.satisfies(coerced, range)) {
    throw new BootCheckError(
      `Hindsight server version ${actual} does not satisfy the supported range "${range}". ` +
        `Upgrade Hindsight, or bump cogmo.hindsightCompat in package.json after verifying compatibility.`,
    );
  }
  logger.info({ actual, range }, "hindsight version check passed");
}

/**
 * Verify a host directory the runtime needs to write into is reachable
 * and writable by the current process. Creates it with `mkdir -p` first
 * (matches the on-demand creation that `provisionAskpass` /
 * `CogmoSocketProxy.create` would otherwise do); then probes `W_OK`.
 *
 * Catches the common misconfiguration where an operator overrides
 * `SANDBOX_ASKPASS_DIR` / `SANDBOX_PROXY_SOCKET_DIR` to a path the
 * runtime user can't write — without this probe the failure surfaces as
 * a sub-second EACCES on the first task and looks transient. The error
 * names the env var so the operator knows exactly what to override.
 */
export async function checkDirWritable(path: string, envVarName: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
    await access(path, fsConstants.W_OK);
  } catch (err) {
    throw new BootCheckError(
      `${envVarName}=${path} is not writable by the cogmo runtime user. ` +
        `Pre-create the directory and chown it to the runtime user, or set ` +
        `${envVarName} to a path the runtime user can write (the shipping ` +
        `image pre-creates /var/lib/cogmo/* with the right ownership). ` +
        `Underlying error: ${stringifyError(err)}`,
    );
  }
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
