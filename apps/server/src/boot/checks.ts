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
 * Assert the bundled `@vectorize-io/hindsight-client` version falls within
 * the same `cogmo.hindsightCompat` range enforced on the server. Client and
 * server publish in lockstep, so a client whose version sits outside the
 * range means the npm dependency and the pin drifted apart in this repo —
 * one was bumped without the other.
 *
 * Pure (no I/O) — the version is a build-time constant the caller passes in.
 * Hard fail, matching `checkHindsightVersion`: a deterministic config error
 * that won't self-heal is worth surfacing at boot before a mismatched client
 * talks to a server it wasn't validated against.
 */
export function checkHindsightClientVersion(range: HindsightCompat, clientVersion: string): void {
  // Coerce to strip any prerelease/build suffix, mirroring the server check —
  // wire-compat is the major/minor/patch question, not the build tag.
  const coerced = semver.coerce(clientVersion)?.version;
  if (coerced === undefined) {
    throw new BootCheckError(
      `@vectorize-io/hindsight-client reported an unparseable version: ${JSON.stringify(clientVersion)}`,
    );
  }
  if (!semver.satisfies(coerced, range)) {
    throw new BootCheckError(
      `@vectorize-io/hindsight-client version ${clientVersion} is outside the supported range "${range}". ` +
        `Bump the client dependency and cogmo.hindsightCompat together.`,
    );
  }
  logger.info({ clientVersion, range }, "hindsight client version check passed");
}

/**
 * Verify a host directory the runtime needs to write into is reachable
 * and writable by the current process. Creates it with `mkdir -p` first
 * (matches the on-demand creation that `provisionAskpass` /
 * `CogmoSocketProxy.create` would otherwise do); then probes `W_OK | X_OK`.
 *
 * Probing both is necessary: POSIX requires write *and* search/traverse
 * on a directory to create files inside it. `mkdir -p` of a fresh dir
 * always sets X via the umask-derived default mode, but a pre-existing
 * dir chmod'd to W-without-X would pass a `W_OK`-only check and still
 * refuse `socket()`/`open()` at runtime.
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
    await access(path, fsConstants.W_OK | fsConstants.X_OK);
  } catch (err) {
    throw new BootCheckError(
      `${envVarName}=${path} is not writable by the cogmo runtime user. ` +
        `Pre-create the directory and chown it to the runtime user, or set ` +
        `${envVarName} to a path the runtime user can write (the shipping ` +
        `image pre-creates /var/lib/cogmo/* with the right ownership). ` +
        `Underlying error: ${stringifyError(err)}`,
      { cause: err },
    );
  }
}

/** The slice of `fetch` the auth probes use — injected so tests need no server. */
export type ProbeFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Append `path` to a service base URL, keeping any path prefix the base
 * carries (`https://gateway/hindsight`). `new URL("/v1/…", base)` would
 * replace the prefix with the absolute path.
 */
function serviceUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * Status code of one probe request, or `null` when the server could not be
 * reached. The body is discarded unread: only the status is evidence.
 */
async function probeStatus(
  fetchFn: ProbeFetch,
  url: string,
  init: RequestInit,
): Promise<number | null> {
  try {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(5_000) });
    await res.body?.cancel();
    return res.status;
  } catch (err) {
    logger.warn({ url, err: stringifyError(err) }, "auth probe could not reach the server");
    return null;
  }
}

function isAuthRejection(status: number): boolean {
  return status === 401 || status === 403;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * A status that proves neither enforcement nor its absence — a 404 from a
 * wrong base path, a 502 from a proxy in front of a restarting server.
 * Soft-fail: warn and stop checking, since later probes would build on an
 * unestablished premise.
 */
function warnInconclusive(service: string, url: string, status: number): void {
  logger.warn(
    { service, url, status },
    "auth probe got a status that neither accepts nor rejects credentials — skipping the rest of the auth check",
  );
}

/**
 * Verify Hindsight enforces its API key, and that ours is the one it holds.
 *
 * Two requests against the bank list, which runs through the tenant
 * extension's `authenticate` (`/health` and `/version` do not):
 * - **Without a token** it must be refused. A 2xx means the server runs the
 *   default no-auth tenant extension, where the key Cogmo sends is ignored —
 *   a credential believed to protect memory that protects nothing.
 * - **With the token** it must succeed, otherwise every memory call fails at
 *   request time on a mismatched key.
 *
 * Those two outcomes are deterministic deployment errors and hard-fail. An
 * unreachable server, or a status that is neither a 2xx nor 401/403,
 * soft-fails, matching `checkHindsightVersion`.
 */
export async function checkHindsightAuth(
  fetchFn: ProbeFetch,
  baseUrl: string,
  apiKey: string,
): Promise<void> {
  const url = serviceUrl(baseUrl, "/v1/default/banks");
  const anonymous = await probeStatus(fetchFn, url, {});
  if (anonymous === null) return;
  if (isSuccess(anonymous)) {
    throw new BootCheckError(
      `Hindsight at ${baseUrl} answered an unauthenticated request (HTTP ${anonymous}). ` +
        `Start it with HINDSIGHT_API_TENANT_EXTENSION=hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension ` +
        `and HINDSIGHT_API_TENANT_API_KEY set to the value of HINDSIGHT_API_KEY.`,
    );
  }
  if (!isAuthRejection(anonymous)) {
    warnInconclusive("hindsight", url, anonymous);
    return;
  }
  const authenticated = await probeStatus(fetchFn, url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (authenticated === null) return;
  if (isAuthRejection(authenticated)) {
    throw new BootCheckError(
      `Hindsight at ${baseUrl} rejected HINDSIGHT_API_KEY (HTTP ${authenticated}). ` +
        `It must equal the server's HINDSIGHT_API_TENANT_API_KEY.`,
    );
  }
  if (!isSuccess(authenticated)) {
    warnInconclusive("hindsight", url, authenticated);
    return;
  }
  logger.info("hindsight auth check passed");
}

export interface InngestAuthConfig {
  baseUrl: string;
  /** `INNGEST_DEV` — the dev server has no keys, so there is nothing to check. */
  dev: boolean;
  eventKey: string | undefined;
  signingKey: string | undefined;
}

/**
 * Verify the self-hosted Inngest server enforces its keys, and that Cogmo
 * holds the right ones.
 *
 * Anything that can post an event to an unkeyed server drives the agent:
 * `adapter/direct/inbound` injects a user turn, `coding/task/plan-approved`
 * approves a plan. `inngest start` refuses to run without keys, but
 * `inngest dev` accepts every request, so a production deployment pointed
 * at a dev server is the failure mode this check exists for.
 *
 * - Both keys must be set.
 * - `GET /v1/events` without a signing key must be refused; a 2xx means the
 *   server is not enforcing keys at all.
 * - The same request with our signing key must succeed.
 * - An empty event batch posted under our event key must succeed. It
 *   creates no event, so the probe has no side effect.
 *
 * An unreachable server, or a status that is neither a 2xx nor 401/403,
 * soft-fails. The whole check is skipped under `INNGEST_DEV`, which is taken
 * at its word: setting it in production disables this check along with the
 * SDK's signature verification, and DEPLOYMENT.md says never to. Keys do not
 * cover the dashboard or its GraphQL API, which can invoke functions — see
 * DEPLOYMENT.md → Securing internal services.
 */
export async function checkInngestAuth(
  fetchFn: ProbeFetch,
  config: InngestAuthConfig,
): Promise<void> {
  if (config.dev) {
    logger.info("INNGEST_DEV set — skipping inngest key check");
    return;
  }
  const { baseUrl, eventKey, signingKey } = config;
  if (eventKey === undefined || signingKey === undefined) {
    throw new BootCheckError(
      "INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY are required unless INNGEST_DEV is set. " +
        "Use the values the server was started with (`inngest start --event-key … --signing-key …`).",
    );
  }
  const eventsUrl = serviceUrl(baseUrl, "/v1/events");
  const anonymous = await probeStatus(fetchFn, eventsUrl, {});
  if (anonymous === null) return;
  if (isSuccess(anonymous)) {
    throw new BootCheckError(
      `Inngest at ${baseUrl} answered an unauthenticated API request (HTTP ${anonymous}), ` +
        "so it is not enforcing keys — likely `inngest dev`. Run `inngest start` with " +
        "--event-key and --signing-key, or set INNGEST_DEV for local development.",
    );
  }
  if (!isAuthRejection(anonymous)) {
    warnInconclusive("inngest", eventsUrl, anonymous);
    return;
  }
  const signed = await probeStatus(fetchFn, eventsUrl, {
    headers: { Authorization: `Bearer ${signingKey}` },
  });
  if (signed === null) return;
  if (isAuthRejection(signed)) {
    throw new BootCheckError(
      `Inngest at ${baseUrl} rejected INNGEST_SIGNING_KEY (HTTP ${signed}). ` +
        "It must equal the server's --signing-key.",
    );
  }
  if (!isSuccess(signed)) {
    warnInconclusive("inngest", eventsUrl, signed);
    return;
  }
  const eventUrl = serviceUrl(baseUrl, `/e/${encodeURIComponent(eventKey)}`);
  const event = await probeStatus(fetchFn, eventUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "[]",
  });
  if (event === null) return;
  if (isAuthRejection(event)) {
    throw new BootCheckError(
      `Inngest at ${baseUrl} rejected INNGEST_EVENT_KEY (HTTP ${event}). ` +
        "It must be one of the server's --event-key values.",
    );
  }
  if (!isSuccess(event)) {
    warnInconclusive("inngest", eventUrl, event);
    return;
  }
  logger.info("inngest auth check passed");
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
