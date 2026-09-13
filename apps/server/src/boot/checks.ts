/**
 * Boot-time dependency checks.
 *
 * Each function probes one external dependency that production code paths
 * silently assume is in place. `checkUuidv7` runs from `bootstrapCore`; the
 * network probes run from `bootstrap()` in `src/index.ts` before the
 * orchestrator starts taking traffic — fail fast at boot beats failing
 * mid-turn after the user has already sent a message.
 *
 * Policy:
 * - **Hard fail at once (throw `BootCheckError`):** deterministic,
 *   deployment-shaped problems that won't self-heal — missing extension,
 *   missing bucket, wrong region, missing or rejected credentials, a server
 *   that answers without auth, a version outside the supported range, a
 *   service URL with embedded credentials. Operator action required.
 * - **Retry, then hard fail:** a dependency that can't be reached, doesn't
 *   answer in time, or answers with a status that proves nothing either way.
 *   Each check gets `BOOT_PROBE_DEADLINE_MS` to become conclusive — long
 *   enough to ride out a restart during a deploy — and makes its last attempt
 *   close to the deadline rather than sleeping into it. Every attempt is
 *   bounded by `BOOT_PROBE_ATTEMPT_TIMEOUT_MS` and by the time left, so a
 *   request that hangs cannot overrun. Past the deadline boot fails closed: a
 *   supervisor restart loop is visible, a check that silently never ran is
 *   not.
 *
 * URLs that reach logs and errors carry no credential: query strings,
 * fragments and userinfo are dropped, and the Inngest event key is redacted.
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

/** How long one check retries an inconclusive answer before failing closed. */
export const BOOT_PROBE_DEADLINE_MS = 60_000;
/** Upper bound on one attempt, including every request it makes. */
export const BOOT_PROBE_ATTEMPT_TIMEOUT_MS = 5_000;
const BOOT_PROBE_MIN_DELAY_MS = 1_000;
const BOOT_PROBE_MAX_DELAY_MS = 10_000;

/** Time source for boot probes — injected so retry and timeout tests do not wait. */
export interface BootClock {
  /** Monotonic milliseconds; only differences are meaningful. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** A signal that aborts after `ms`. */
  timeout(ms: number): AbortSignal;
}

export const systemBootClock: BootClock = {
  // Monotonic: a wall-clock step at boot (NTP correcting an RTC-less host)
  // must not end the deadline early or stretch it.
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  timeout: (ms) => AbortSignal.timeout(ms),
};

type ProbeAttempt<T> = { conclusive: true; value: T } | { conclusive: false; reason: string };

function conclusive<T>(value: T): ProbeAttempt<T> {
  return { conclusive: true, value };
}

/**
 * Run `attempt` until it is conclusive, backing off between tries, and fail
 * closed at the deadline. Each attempt receives a signal that aborts after
 * `BOOT_PROBE_ATTEMPT_TIMEOUT_MS` or at the deadline, whichever is sooner;
 * the attempt must pass it to every request it makes. A `BootCheckError`
 * thrown by `attempt` is a deterministic verdict and propagates at once.
 *
 * Backoff never sleeps into the deadline: when little time is left, the wait
 * shrinks so another attempt still fits, down to `BOOT_PROBE_MIN_DELAY_MS`
 * between attempts. The last attempt therefore starts within that interval
 * of the deadline.
 */
async function retryUntilConclusive<T>(
  label: string,
  clock: BootClock,
  attempt: (signal: AbortSignal) => Promise<ProbeAttempt<T>>,
): Promise<T> {
  const deadline = clock.now() + BOOT_PROBE_DEADLINE_MS;
  let delay = BOOT_PROBE_MIN_DELAY_MS;
  let lastReason = "no attempt completed";
  for (;;) {
    const remaining = deadline - clock.now();
    if (remaining <= 0) {
      throw new BootCheckError(
        `${label} could not reach a conclusive answer within ${BOOT_PROBE_DEADLINE_MS / 1000}s ` +
          `(last: ${lastReason}). Refusing to start unverified.`,
      );
    }
    const result = await attempt(clock.timeout(Math.min(BOOT_PROBE_ATTEMPT_TIMEOUT_MS, remaining)));
    if (result.conclusive) return result.value;
    lastReason = result.reason;
    const left = deadline - clock.now();
    if (left <= 0) continue;
    const roomForAnotherAttempt = left - BOOT_PROBE_ATTEMPT_TIMEOUT_MS;
    const wait = Math.min(
      delay,
      Math.max(roomForAnotherAttempt, Math.min(BOOT_PROBE_MIN_DELAY_MS, left)),
    );
    logger.warn(
      { label, reason: result.reason, retryInMs: wait },
      `${label} inconclusive — retrying`,
    );
    await clock.sleep(wait);
    delay = Math.min(delay * 2, BOOT_PROBE_MAX_DELAY_MS);
  }
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
 *
 * Not retried: migrations run against the same database immediately before,
 * so a failure here is the function, not the connection.
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

const AwsServiceErrorSchema = z.object({
  $metadata: z.object({ httpStatusCode: z.number() }),
  $response: z.object({ headers: z.record(z.string(), z.unknown()) }).optional(),
});

/** Status and bucket region an AWS SDK service error carries; absent for network failures. */
function awsServiceError(
  err: unknown,
): { status: number; bucketRegion: string | undefined } | undefined {
  const parsed = AwsServiceErrorSchema.safeParse(err);
  if (!parsed.success) return undefined;
  const region = parsed.data.$response?.headers["x-amz-bucket-region"];
  return {
    status: parsed.data.$metadata.httpStatusCode,
    bucketRegion: typeof region === "string" ? region : undefined,
  };
}

/**
 * Verify the configured S3 bucket exists and credentials are valid.
 * `HeadBucket` is the cheapest probe — no list, no read, no write.
 *
 * The store's verdicts fail at once:
 * - no credentials could be loaded (`CredentialsProviderError`, which has no
 *   HTTP status because no request was sent);
 * - a 301 — how S3 answers for a bucket in another region when the client
 *   does not follow region redirects;
 * - any other 4xx (missing bucket, bad credentials), except 429 and S3's
 *   transient `400 RequestTimeout`.
 *
 * A network error, timeout, 5xx, 429, `RequestTimeout` or temporary redirect
 * is retried up to the boot probe deadline.
 */
export async function checkS3Bucket(s3: S3Client, bucket: string, clock: BootClock): Promise<void> {
  await retryUntilConclusive(`S3 bucket "${bucket}" check`, clock, async (signal) => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal });
      return conclusive(undefined);
    } catch (err) {
      const name = err instanceof Error ? err.name : undefined;
      if (name === "CredentialsProviderError") {
        throw new BootCheckError(
          `S3 credentials could not be loaded for bucket "${bucket}". Set S3_ACCESS_KEY and ` +
            `S3_SECRET_KEY, or provide ambient AWS credentials. Underlying error: ${stringifyError(err)}`,
        );
      }
      const service = awsServiceError(err);
      if (service?.status === 301) {
        throw new BootCheckError(
          `S3 bucket "${bucket}" is in a different region than S3_REGION` +
            `${service.bucketRegion !== undefined ? ` (the bucket is in ${service.bucketRegion})` : ""}. ` +
            `Set S3_REGION to the bucket's region. Underlying error: ${stringifyError(err)}`,
        );
      }
      const isVerdict =
        service !== undefined &&
        service.status >= 400 &&
        service.status < 500 &&
        service.status !== 429 &&
        name !== "RequestTimeout";
      if (isVerdict) {
        throw new BootCheckError(
          `S3 bucket "${bucket}" not reachable. Check S3_ENDPOINT, ` +
            `S3_ACCESS_KEY/S3_SECRET_KEY, S3_REGION, and that the bucket exists. ` +
            `Underlying error: ${stringifyError(err)}`,
        );
      }
      return { conclusive: false, reason: stringifyError(err) };
    }
  });
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
 * When `/version` can't be read, retry up to the boot probe deadline, then
 * fail closed.
 */
export async function checkHindsightVersion(
  memory: HindsightMemoryProvider,
  range: HindsightCompat,
  clock: BootClock,
): Promise<void> {
  const actual = await retryUntilConclusive("hindsight version check", clock, async (signal) => {
    try {
      return conclusive(await memory.getServerVersion(signal));
    } catch (err) {
      return { conclusive: false, reason: stringifyError(err) };
    }
  });
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

export interface BootProbeDeps {
  fetch: ProbeFetch;
  clock: BootClock;
}

/**
 * Append `path` to a service base URL, keeping any path prefix the base
 * carries (`https://gateway/hindsight`) and any query or fragment in place.
 */
function serviceUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  return url.toString();
}

/**
 * `url` as it may appear in logs and errors: userinfo, query and fragment
 * dropped, and with `redactLastSegment` the final path segment — where the
 * Inngest event URL carries its key — replaced by `REDACTED`.
 */
function displayUrl(url: string, options: { redactLastSegment: boolean }): string {
  const shown = new URL(url);
  shown.username = "";
  shown.password = "";
  shown.search = "";
  shown.hash = "";
  if (options.redactLastSegment) {
    shown.pathname = shown.pathname.replace(/[^/]+$/, "REDACTED");
  }
  return shown.toString();
}

/**
 * Reject a service URL with embedded credentials at once. `fetch` refuses to
 * build a request from one, so every attempt would fail the same way until
 * the deadline — and the credentials belong in the service's own key, not
 * the URL.
 */
function assertNoEmbeddedCredentials(envVarName: string, baseUrl: string): void {
  const url = new URL(baseUrl);
  if (url.username !== "" || url.password !== "") {
    throw new BootCheckError(
      `${envVarName} must not embed credentials (${displayUrl(baseUrl, { redactLastSegment: false })}). ` +
        "Remove the user:password part of the URL.",
    );
  }
}

type ProbeResult = { kind: "status"; status: number } | { kind: "unreachable"; error: string };

/** One probe request. The body is discarded unread: only the status is evidence. */
async function probe(
  fetchFn: ProbeFetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal });
  } catch (err) {
    return { kind: "unreachable", error: stringifyError(err) };
  }
  // Discarding the body rejects if the attempt signal fires after the headers
  // arrived. The status is already in hand, and it is the whole result.
  await res.body?.cancel().catch(() => undefined);
  return { kind: "status", status: res.status };
}

function isAuthRejection(result: ProbeResult): boolean {
  return result.kind === "status" && (result.status === 401 || result.status === 403);
}

function isSuccess(result: ProbeResult): boolean {
  return result.kind === "status" && result.status >= 200 && result.status < 300;
}

function statusText(result: ProbeResult): string {
  return result.kind === "status" ? `HTTP ${result.status}` : result.error;
}

/**
 * Unreachable, timed out, or a status that proves neither enforcement nor
 * its absence — a 404 from a wrong base path, a 502 from a proxy in front of
 * a restarting server. Retried until the deadline. `shownUrl` reaches logs
 * and the final error, so it must come from `displayUrl`.
 */
function inconclusive(shownUrl: string, result: ProbeResult): ProbeAttempt<void> {
  return { conclusive: false, reason: `${shownUrl} → ${statusText(result)}` };
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
 * Those two outcomes hard-fail at once. Anything else is retried until
 * conclusive, then fails closed.
 */
export async function checkHindsightAuth(
  deps: BootProbeDeps,
  baseUrl: string,
  apiKey: string,
): Promise<void> {
  assertNoEmbeddedCredentials("HINDSIGHT_URL", baseUrl);
  const shownBase = displayUrl(baseUrl, { redactLastSegment: false });
  const url = serviceUrl(baseUrl, "/v1/default/banks");
  const shownUrl = displayUrl(url, { redactLastSegment: false });
  await retryUntilConclusive("hindsight auth check", deps.clock, async (signal) => {
    const anonymous = await probe(deps.fetch, url, {}, signal);
    if (isSuccess(anonymous)) {
      throw new BootCheckError(
        `Hindsight at ${shownBase} answered an unauthenticated request (${statusText(anonymous)}). ` +
          `Start it with HINDSIGHT_API_TENANT_EXTENSION=hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension ` +
          `and HINDSIGHT_API_TENANT_API_KEY set to the value of HINDSIGHT_API_KEY.`,
      );
    }
    if (!isAuthRejection(anonymous)) return inconclusive(shownUrl, anonymous);
    const authenticated = await probe(
      deps.fetch,
      url,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      signal,
    );
    if (isAuthRejection(authenticated)) {
      throw new BootCheckError(
        `Hindsight at ${shownBase} rejected HINDSIGHT_API_KEY (${statusText(authenticated)}). ` +
          `It must equal the server's HINDSIGHT_API_TENANT_API_KEY.`,
      );
    }
    if (!isSuccess(authenticated)) return inconclusive(shownUrl, authenticated);
    return conclusive(undefined);
  });
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
 * Any other outcome is retried until conclusive, then fails closed. The
 * whole check is skipped under `INNGEST_DEV`, which is taken at its word:
 * setting it in production disables this check along with the SDK's
 * signature verification, and DEPLOYMENT.md says never to. Keys do not cover
 * the dashboard or its GraphQL API, which can invoke functions — see
 * DEPLOYMENT.md → Securing internal services.
 */
export async function checkInngestAuth(
  deps: BootProbeDeps,
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
  assertNoEmbeddedCredentials("INNGEST_BASE_URL", baseUrl);
  const shownBase = displayUrl(baseUrl, { redactLastSegment: false });
  const eventsUrl = serviceUrl(baseUrl, "/v1/events");
  const shownEventsUrl = displayUrl(eventsUrl, { redactLastSegment: false });
  const eventUrl = serviceUrl(baseUrl, `/e/${encodeURIComponent(eventKey)}`);
  const shownEventUrl = displayUrl(eventUrl, { redactLastSegment: true });
  await retryUntilConclusive("inngest auth check", deps.clock, async (signal) => {
    const anonymous = await probe(deps.fetch, eventsUrl, {}, signal);
    if (isSuccess(anonymous)) {
      throw new BootCheckError(
        `Inngest at ${shownBase} answered an unauthenticated API request (${statusText(anonymous)}), ` +
          "so it is not enforcing keys — likely `inngest dev`. Run `inngest start` with " +
          "--event-key and --signing-key, or set INNGEST_DEV for local development.",
      );
    }
    if (!isAuthRejection(anonymous)) return inconclusive(shownEventsUrl, anonymous);
    const signed = await probe(
      deps.fetch,
      eventsUrl,
      { headers: { Authorization: `Bearer ${signingKey}` } },
      signal,
    );
    if (isAuthRejection(signed)) {
      throw new BootCheckError(
        `Inngest at ${shownBase} rejected INNGEST_SIGNING_KEY (${statusText(signed)}). ` +
          "It must equal the server's --signing-key.",
      );
    }
    if (!isSuccess(signed)) return inconclusive(shownEventsUrl, signed);
    const event = await probe(
      deps.fetch,
      eventUrl,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" },
      signal,
    );
    if (isAuthRejection(event)) {
      throw new BootCheckError(
        `Inngest at ${shownBase} rejected INNGEST_EVENT_KEY (${statusText(event)}). ` +
          "It must be one of the server's --event-key values.",
      );
    }
    if (!isSuccess(event)) return inconclusive(shownEventUrl, event);
    return conclusive(undefined);
  });
  logger.info("inngest auth check passed");
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
