/**
 * Boot-time dependency checks.
 *
 * `checkUuidv7`, `checkS3KeyPair` and `checkHindsightClientVersion` run from
 * `bootstrapCore`, `checkDirWritable` from `bootstrapSandbox`, and the network
 * probes from `bootstrap()` — Hindsight's also from the memory CLIs.
 *
 * Policy: a deterministic, deployment-shaped problem throws `BootCheckError`
 * at once. A dependency that can't be reached or answers inconclusively is
 * retried until `BOOT_PROBE_DEADLINE_MS`, then boot fails closed: a restart
 * loop with the reason logged is visible, a check that silently never ran is
 * not.
 */

import { constants as fsConstants, readFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";
import { HeadBucketCommand, type S3Client } from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import semver from "semver";
import { z } from "zod";
import type { Database } from "../db/index.js";
import { logger } from "../logger.js";
import type { HindsightMemoryProvider } from "../memory/hindsight.js";
import { describeError } from "../util/describe-error.js";

export class BootCheckError extends Error {
  override readonly name = "BootCheckError";

  /** Scrubs `user:password@` from any URL the message quotes. */
  constructor(message: string, options?: ErrorOptions) {
    super(scrubUrlCredentials(message), options);
  }
}

/** How long one check retries an inconclusive answer before failing closed. */
export const BOOT_PROBE_DEADLINE_MS = 60_000;
/** Upper bound on one attempt, including every request it makes. */
export const BOOT_PROBE_ATTEMPT_TIMEOUT_MS = 5_000;
const BOOT_PROBE_MIN_DELAY_MS = 1_000;
const BOOT_PROBE_MAX_DELAY_MS = 10_000;
/** Least time worth giving a retry: less would only time out and hide the real reason. */
const BOOT_PROBE_MIN_ATTEMPT_MS = 1_000;

/** Replace the userinfo of any URL in `text`, up to the last `@` before the host. */
function scrubUrlCredentials(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1REDACTED@");
}

/** Time source for boot probes — injected so retry and timeout tests do not wait. */
export interface BootClock {
  /** Monotonic milliseconds; only differences are meaningful. */
  now(): number;
  /** Resolves after `ms`; rejects early, clearing its timer, once `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** A signal that aborts after `ms`. */
  timeout(ms: number): AbortSignal;
}

export const systemBootClock: BootClock = {
  // Monotonic, so a clock step at boot doesn't move the deadline.
  now: () => performance.now(),
  sleep: (ms, signal) => sleepFor(ms, undefined, { signal }),
  timeout: (ms) => AbortSignal.timeout(ms),
};

/** The clock, and a signal that aborts once a check run alongside has failed boot. */
export interface BootProbeContext {
  clock: BootClock;
  cancel: AbortSignal;
}

/** Context for a check that runs on its own, which nothing cancels. */
export function independentProbeContext(): BootProbeContext {
  return { clock: systemBootClock, cancel: new AbortController().signal };
}

/** Start `check` asynchronously, so one that throws while starting rejects like any other. */
function start(
  check: (context: BootProbeContext) => Promise<void>,
  context: BootProbeContext,
): Promise<void> {
  return Promise.resolve().then(() => check(context));
}

/**
 * Run checks together. The first failure cancels the rest; the call rejects
 * with it only once every check has settled.
 */
export async function runBootChecks(
  parent: BootProbeContext,
  checks: ReadonlyArray<(context: BootProbeContext) => Promise<void>>,
): Promise<void> {
  const failed = new AbortController();
  const context: BootProbeContext = {
    clock: parent.clock,
    cancel: AbortSignal.any([parent.cancel, failed.signal]),
  };
  await Promise.allSettled(
    checks.map((check) =>
      start(check, context).catch((err: unknown) => {
        if (!failed.signal.aborted) failed.abort(err);
        throw err;
      }),
    ),
  );
  if (failed.signal.aborted) throw failed.signal.reason;
}

/**
 * Run Hindsight's auth and version checks together, reporting an auth failure
 * ahead of a version failure — an unkeyed server answers its open `/version`
 * first. An auth failure cancels the version check; a version failure does
 * not cancel auth.
 */
export async function runHindsightChecks(
  context: BootProbeContext,
  checks: {
    auth: (context: BootProbeContext) => Promise<void>;
    version: (context: BootProbeContext) => Promise<void>;
  },
): Promise<void> {
  const authFailed = new AbortController();
  const versionContext: BootProbeContext = {
    clock: context.clock,
    cancel: AbortSignal.any([context.cancel, authFailed.signal]),
  };
  const [auth, version] = await Promise.allSettled([
    start(checks.auth, context).catch((err: unknown) => {
      authFailed.abort(err);
      throw err;
    }),
    start(checks.version, versionContext),
  ]);
  if (auth.status === "rejected") throw auth.reason;
  if (version.status === "rejected") throw version.reason;
}

type ProbeAttempt<T> = { conclusive: true; value: T } | { conclusive: false; reason: string };

function conclusive<T>(value: T): ProbeAttempt<T> {
  return { conclusive: true, value };
}

/**
 * Retry `attempt` with backoff until it is conclusive, failing closed at the
 * deadline. Each attempt's signal aborts on its timeout, the deadline or
 * `context.cancel`, and must reach every request it makes. A `BootCheckError`
 * from `attempt` propagates at once. A retry runs only if it gets
 * `BOOT_PROBE_MIN_ATTEMPT_MS`, checked again after the wait.
 */
async function retryUntilConclusive<T>(
  label: string,
  context: BootProbeContext,
  attempt: (signal: AbortSignal) => Promise<ProbeAttempt<T>>,
): Promise<T> {
  const { clock, cancel } = context;
  const deadline = clock.now() + BOOT_PROBE_DEADLINE_MS;
  const failClosed = (reason: string) =>
    new BootCheckError(
      `${label} could not reach a conclusive answer within ${BOOT_PROBE_DEADLINE_MS / 1000}s ` +
        `(last: ${reason}). Refusing to start unverified.`,
    );
  let delay = BOOT_PROBE_MIN_DELAY_MS;
  let lastReason = "no attempt completed";
  let attempts = 0;
  for (;;) {
    if (cancel.aborted) {
      throw new BootCheckError(`${label} abandoned: another boot check already failed.`);
    }
    const remaining = deadline - clock.now();
    if (remaining <= 0 || (attempts > 0 && remaining < BOOT_PROBE_MIN_ATTEMPT_MS)) {
      throw failClosed(lastReason);
    }
    attempts += 1;
    const result = await attempt(
      AbortSignal.any([clock.timeout(Math.min(BOOT_PROBE_ATTEMPT_TIMEOUT_MS, remaining)), cancel]),
    );
    if (result.conclusive) return result.value;
    lastReason = scrubUrlCredentials(result.reason);
    if (cancel.aborted) continue;
    const left = deadline - clock.now();
    if (left < BOOT_PROBE_MIN_DELAY_MS + BOOT_PROBE_MIN_ATTEMPT_MS) throw failClosed(lastReason);
    const wait = Math.min(
      delay,
      Math.max(left - BOOT_PROBE_ATTEMPT_TIMEOUT_MS, BOOT_PROBE_MIN_DELAY_MS),
    );
    logger.warn({ label, reason: lastReason, retryInMs: wait }, `${label} inconclusive — retrying`);
    try {
      await clock.sleep(wait, cancel);
    } catch (err) {
      // A cancelled wait ends the loop at the top.
      if (!cancel.aborted) throw err;
    }
    delay = Math.min(delay * 2, BOOT_PROBE_MAX_DELAY_MS);
  }
}

/**
 * Settle with `work`, or reject once `signal` aborts. For calls that honour
 * the signal only partly (S3 credential resolution, Hindsight request setup);
 * the abandoned call's outcome is dropped.
 */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolveWork, rejectWork) => {
    const onAbort = () => rejectWork(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolveWork(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectWork(err);
      },
    );
  });
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
 * Not retried: migrations have just used the connection.
 */
export async function checkUuidv7(db: Database): Promise<void> {
  try {
    await db.execute(sql`SELECT uuidv7()`);
  } catch (err) {
    throw new BootCheckError(
      `uuidv7() not callable — required for table primary keys. ` +
        `Run scripts/init-db.sql against the database, or upgrade to PG18+ ` +
        `(native uuidv7). Underlying error: ${describeError(err)}`,
    );
  }
}

/** Reject a half-set S3 key pair: with one key the client silently uses ambient credentials. */
export function checkS3KeyPair(accessKey: string | undefined, secretKey: string | undefined): void {
  if ((accessKey === undefined) !== (secretKey === undefined)) {
    throw new BootCheckError(
      "S3_ACCESS_KEY and S3_SECRET_KEY must be set together, or both left unset for ambient " +
        "credentials. With only one set, the S3 client would silently use ambient credentials.",
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

/** The bucket `checkS3Bucket` probes, and the region the client is configured for. */
export interface S3BucketTarget {
  bucket: string;
  region: string;
}

/**
 * `HeadBucket` the configured bucket. A HEAD error has no body (the SDK names
 * every non-404 `Unknown`), so classification uses the status and the
 * `x-amz-bucket-region` header. Fails at once on another region — a 301, or a
 * 400 whose header differs from `target.region` (S3 sends it for existing
 * buckets, so a same-region 400 carries it too) — and on any other 4xx except
 * 400 and 429. Retries the rest, including credentials that fail to load
 * (ambient, possibly a slow metadata endpoint).
 */
export async function checkS3Bucket(
  s3: S3Client,
  target: S3BucketTarget,
  context: BootProbeContext,
): Promise<void> {
  const { bucket, region } = target;
  await retryUntilConclusive(`S3 bucket "${bucket}" check`, context, async (signal) => {
    try {
      await abortable(
        s3.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal }),
        signal,
      );
      return conclusive(undefined);
    } catch (err) {
      const service = awsServiceError(err);
      const otherRegion =
        service !== undefined &&
        (service.status === 301 ||
          (service.status === 400 &&
            service.bucketRegion !== undefined &&
            service.bucketRegion !== region));
      if (service !== undefined && otherRegion) {
        throw new BootCheckError(
          `S3 bucket "${bucket}" is in a different region than S3_REGION (${region})` +
            `${service.bucketRegion !== undefined ? `: the bucket is in ${service.bucketRegion}` : ""}. ` +
            `Set S3_REGION to the bucket's region. Underlying error: HTTP ${service.status} ${describeError(err)}`,
        );
      }
      if (
        service !== undefined &&
        service.status > 400 &&
        service.status < 500 &&
        service.status !== 429
      ) {
        throw new BootCheckError(
          `S3 bucket "${bucket}" not reachable. Check S3_ENDPOINT, ` +
            `S3_ACCESS_KEY/S3_SECRET_KEY, S3_REGION, and that the bucket exists. ` +
            `Underlying error: HTTP ${service.status} ${describeError(err)}`,
        );
      }
      if (err instanceof Error && err.name === "CredentialsProviderError") {
        return {
          conclusive: false,
          reason:
            `S3 credentials could not be loaded for bucket "${bucket}" — set S3_ACCESS_KEY and ` +
            `S3_SECRET_KEY, or provide ambient AWS credentials (${describeError(err)})`,
        };
      }
      return {
        conclusive: false,
        reason:
          service !== undefined
            ? `HTTP ${service.status} ${describeError(err)}`
            : describeError(err),
      };
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
 * fix the deployment, not retry. An unreadable `/version` is retried up to
 * the boot probe deadline.
 */
export async function checkHindsightVersion(
  memory: HindsightMemoryProvider,
  range: HindsightCompat,
  context: BootProbeContext,
): Promise<void> {
  const actual = await retryUntilConclusive("hindsight version check", context, async (signal) => {
    try {
      return conclusive(await abortable(memory.getServerVersion(signal), signal));
    } catch (err) {
      return { conclusive: false, reason: describeError(err) };
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
        `Underlying error: ${describeError(err)}`,
      { cause: err },
    );
  }
}

/** The slice of `fetch` the auth probes use — injected so tests need no server. */
export type ProbeFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface BootProbeDeps extends BootProbeContext {
  fetch: ProbeFetch;
}

/** Append `path` to a base URL, keeping its path prefix, query and fragment. */
function serviceUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  return url.toString();
}

/** `url` for logs: no userinfo, query or fragment; `redactLastSegment` hides the Inngest event key. */
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

/** Fail at once on credentials in a service URL: `fetch` would refuse every attempt. */
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

/** One probe request; only its status matters. */
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
    return { kind: "unreachable", error: describeError(err) };
  }
  // Cancelling the body rejects if the signal fired after the headers; the status stands.
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

/** A result that neither proves nor disproves enforcement. `shownUrl` must come from `displayUrl`. */
function inconclusive(shownUrl: string, result: ProbeResult): ProbeAttempt<void> {
  return { conclusive: false, reason: `${shownUrl} → ${statusText(result)}` };
}

/**
 * Verify Hindsight enforces its API key and holds ours: the bank list, which
 * goes through the tenant extension, must refuse an anonymous request and
 * accept our token. Either failing is a verdict; anything else is retried.
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
  await retryUntilConclusive("hindsight auth check", deps, async (signal) => {
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
  /** `INNGEST_DEV`: the dev server has no keys. */
  dev: boolean;
  eventKey: string | undefined;
  signingKey: string | undefined;
}

/**
 * Verify self-hosted Inngest enforces its keys and holds ours: `GET /v1/events`
 * must refuse an anonymous request and accept the signing key, and an empty
 * event batch — which creates no event — must be accepted under the event key.
 * Skipped under `INNGEST_DEV`, which also disables SDK signature verification;
 * never set it in production. Keys don't cover the dashboard or GraphQL API —
 * see DEPLOYMENT.md → Securing internal services.
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
  await retryUntilConclusive("inngest auth check", deps, async (signal) => {
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
