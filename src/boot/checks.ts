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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
 * Wildcards (`*`, empty string, `>=0.0.0`) are rejected — they make the
 * version check a no-op, which is almost certainly a mistake.
 */
export const HindsightCompatSchema = z
  .string()
  .min(1, { message: "must not be empty" })
  .refine((s) => semver.validRange(s) !== null, {
    message: "must be a valid node-semver range",
  })
  .refine((s) => semver.validRange(s) !== "*", {
    message: "wildcard ranges (`*`, empty string) are rejected — pin a real range",
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
  // Resolve relative to this module: `src/boot/checks.ts` (or
  // `dist/boot/checks.js`) → `../../package.json`. Both layouts share
  // the same depth.
  const pkgUrl = new URL("../../package.json", import.meta.url);
  const raw = readFileSync(fileURLToPath(pkgUrl), "utf-8");
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

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
