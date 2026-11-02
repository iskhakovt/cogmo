import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import * as R from "remeda";
import { match } from "ts-pattern";
import { z } from "zod";
import { logger } from "../../logger.js";
import { describeError } from "../../util/describe-error.js";
import { type LockfileEntry, type LockfileSnapshot, parseLockfileEntries } from "../deps.js";
import {
  type BundledPackage,
  normalizePackageName,
  PURE_WHEEL_SUFFIXES,
} from "../pyodide-compat.js";
import type { Tier1Packages, Tier1Prefetcher } from "./tier1.js";

const log = logger.child({ component: "skills.wheel-cache" });

/** A published wheel directory is named by the lockfile's sha256. */
const HASH_DIR_RE = /^[0-9a-f]{64}$/;

/** An in-flight publish: `<hash>.tmp.<id>`. */
const TMP_DIR_RE = /^[0-9a-f]{64}\.tmp\./;

/** A `tmp` directory this old belongs to a publish that died. */
const STALE_TMP_MS = 10 * 60 * 1000;

/** Wall-clock cap on each PyPI request, the metadata lookup and the download alike. */
const REQUEST_TIMEOUT_MS = 60_000;

const READY_MARKER = ".ready";

/** A wheel filename from PyPI, written as a plain entry of the directory and nowhere else. */
const SAFE_WHEEL_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+!-]*\.whl$/;

const PypiReleaseFilesSchema = z.object({
  urls: z.array(
    z.object({
      packagetype: z.string(),
      filename: z.string(),
      url: z.string(),
      digests: z.object({ sha256: z.string() }),
    }),
  ),
});

/**
 * Why a lockfile's tier-1 packages could not be provided. The wheel kinds
 * name the package: `wheel_unavailable` and `hash_mismatch` are terminal for
 * the lockfile (PyPI does not serve a pure-Python wheel with a pinned hash),
 * while `network_failed`, `prefetch_failed` and `publish_failed` may clear on
 * a retry.
 */
export type Tier1PackagesError =
  | { kind: "wheel_unavailable"; spec: string; message: string }
  | { kind: "hash_mismatch"; spec: string; message: string }
  | { kind: "network_failed"; spec: string; message: string }
  | { kind: "prefetch_failed"; message: string }
  | { kind: "publish_failed"; message: string };

export interface EnsureTier1PackagesDeps {
  prefetcher: Tier1Prefetcher;
  fetchImpl: typeof fetch;
  /** Pyodide's bundled packages by normalised name (`loadBundledPackages`). */
  bundled: ReadonlyMap<string, BundledPackage>;
}

export interface EnsureTier1PackagesArgs {
  lockfile: LockfileSnapshot;
  /** Pyodide's package cache, which `prefetchBuiltins` fills. */
  packageCacheDir: string;
  /** Parent of the per-lockfile-hash wheel directories. */
  wheelsRoot: string;
  signal?: AbortSignal;
}

/**
 * Provide what a tier-1 child installs for `lockfile` (design/skills.md →
 * Tier-1 boundary, layer 4). A package Pyodide bundles at the locked version
 * is a builtin, fetched into `packageCacheDir`; every other package is a
 * pure-Python wheel from PyPI, checked against the lockfile's sha256 and
 * published under `<wheelsRoot>/<lockfile hash>/`.
 *
 * The directory is published as the venvs are: written under
 * `<hash>.tmp.<id>`, marked `.ready`, renamed into place, then made
 * read-only. Two publishers of one hash leave one copy; the loser of the
 * rename succeeds once it sees the winner's `.ready`. Nothing in it is a
 * link, since the child's permission model follows links out of the grant.
 */
/** One line naming why the lockfile's packages could not be made available. */
export function describeTier1PackagesError(error: Tier1PackagesError): string {
  return match(error)
    .with(
      { kind: "wheel_unavailable" },
      { kind: "hash_mismatch" },
      { kind: "network_failed" },
      (e) => `${e.kind}: ${e.spec}: ${e.message}`,
    )
    .with({ kind: "prefetch_failed" }, { kind: "publish_failed" }, (e) => `${e.kind}: ${e.message}`)
    .exhaustive();
}

export async function ensureTier1Packages(
  deps: EnsureTier1PackagesDeps,
  args: EnsureTier1PackagesArgs,
): Promise<Result<Tier1Packages, Tier1PackagesError>> {
  const [builtinEntries, wheelEntries] = R.partition(
    parseLockfileEntries(args.lockfile.contents),
    (e) => deps.bundled.get(normalizePackageName(e.name))?.version === e.version,
  );
  const builtins = builtinEntries.map((e) => normalizePackageName(e.name));
  if (builtins.length > 0) {
    const prefetched = await deps.prefetcher.prefetchBuiltins(builtins, {
      packageCacheDir: args.packageCacheDir,
      ...(args.signal && { signal: args.signal }),
    });
    if (prefetched.isErr()) return err({ kind: "prefetch_failed", message: prefetched.error });
  }
  if (wheelEntries.length === 0) return ok({ builtins, wheelDir: null });
  const published = await publishWheelDir(deps.fetchImpl, args, wheelEntries);
  return published.map((wheelDir) => ({ builtins, wheelDir }));
}

/** Files `0o444`, then the directory `0o555`: what the permission grant lets a child read and nothing writes. */
async function sealReadOnly(target: string): Promise<void> {
  const names = await readdir(target);
  await Promise.all(names.map((name) => chmod(join(target, name), 0o444)));
  await chmod(target, 0o555);
}

async function publishWheelDir(
  fetchImpl: typeof fetch,
  args: EnsureTier1PackagesArgs,
  entries: readonly LockfileEntry[],
): Promise<Result<string, Tier1PackagesError>> {
  const hash = args.lockfile.hash;
  if (!HASH_DIR_RE.test(hash)) {
    throw new Error(`ensureTier1Packages: lockfile hash ${hash} is not a sha256 hex digest`);
  }
  const target = join(args.wheelsRoot, hash);
  if (await isReady(target)) {
    // A publisher that died between its rename and its chmod left the
    // directory writable; sealing is idempotent, so every reader re-applies it.
    await sealReadOnly(target);
    return ok(target);
  }

  const tmp = join(args.wheelsRoot, `${hash}.tmp.${randomUUID()}`);
  try {
    await mkdir(args.wheelsRoot, { recursive: true });
    await removeStaleTmpDirs(args.wheelsRoot, Date.now());
    await mkdir(tmp);
    for (const entry of entries) {
      const wheel = await fetchVerifiedWheel(fetchImpl, entry, args.signal);
      if (wheel.isErr()) return err(wheel.error);
      await writeFile(join(tmp, wheel.value.filename), wheel.value.bytes, {
        flag: "wx",
        mode: 0o444,
      });
    }
    await writeFile(join(tmp, READY_MARKER), "", { flag: "wx", mode: 0o444 });
    try {
      await rename(tmp, target);
    } catch (e) {
      // A concurrent publisher renamed first; its copy is the one readers use.
      if (await isReady(target)) {
        await sealReadOnly(target);
        return ok(target);
      }
      return err({
        kind: "publish_failed",
        message: `rename ${tmp} -> ${target} failed and ${target} is not ready: ${describeError(e)}`,
      });
    }
    await sealReadOnly(target);
    return ok(target);
  } catch (e) {
    return err({ kind: "publish_failed", message: describeError(e) });
  } finally {
    // Gone after a successful rename; the remains of a failed or lost publish otherwise.
    await rm(tmp, { recursive: true, force: true }).catch((e: unknown) => {
      log.warn({ tmp, err: describeError(e) }, "wheel-cache: tmp dir cleanup failed");
    });
  }
}

/**
 * Whether `dir` is a published wheel directory. A marker that cannot be
 * stat'ed counts as unpublished: the publish that follows reports the
 * filesystem's failure.
 */
async function isReady(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, READY_MARKER));
    return true;
  } catch {
    return false;
  }
}

async function fetchVerifiedWheel(
  fetchImpl: typeof fetch,
  entry: LockfileEntry,
  signal: AbortSignal | undefined,
): Promise<Result<{ filename: string; bytes: Buffer }, Tier1PackagesError>> {
  const spec = `${entry.name}==${entry.version}`;
  const requestSignal = () =>
    signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  let body: unknown;
  try {
    const resp = await fetchImpl(
      `https://pypi.org/pypi/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}/json`,
      { headers: { Accept: "application/json" }, signal: requestSignal() },
    );
    if (resp.status === 404) {
      return err({ kind: "wheel_unavailable", spec, message: `PyPI has no release ${spec}` });
    }
    if (!resp.ok) {
      return err({ kind: "network_failed", spec, message: `pypi http ${resp.status} for ${spec}` });
    }
    body = await resp.json();
  } catch (e) {
    return err({ kind: "network_failed", spec, message: `pypi lookup: ${describeError(e)}` });
  }
  const parsed = PypiReleaseFilesSchema.safeParse(body);
  if (!parsed.success) {
    return err({ kind: "network_failed", spec, message: "pypi answered in an unknown shape" });
  }
  const file = parsed.data.urls.find(
    (u) =>
      u.packagetype === "bdist_wheel" &&
      PURE_WHEEL_SUFFIXES.some((suffix) => u.filename.endsWith(suffix)) &&
      entry.sha256.includes(u.digests.sha256.toLowerCase()),
  );
  if (!file) {
    return err({
      kind: "wheel_unavailable",
      spec,
      message: `no pure-Python wheel on PyPI carries a sha256 the lockfile pins for ${spec}`,
    });
  }
  if (!SAFE_WHEEL_FILENAME_RE.test(file.filename) || !file.url.startsWith("https://")) {
    return err({
      kind: "wheel_unavailable",
      spec,
      message: `PyPI lists ${spec}'s wheel as ${JSON.stringify(file.filename)} at ${JSON.stringify(file.url)}, which is not a plain filename over https`,
    });
  }

  let bytes: Buffer;
  try {
    const resp = await fetchImpl(file.url, { signal: requestSignal() });
    if (!resp.ok) {
      return err({
        kind: "network_failed",
        spec,
        message: `wheel download http ${resp.status} for ${file.filename}`,
      });
    }
    bytes = Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    return err({ kind: "network_failed", spec, message: `wheel download: ${describeError(e)}` });
  }
  const expected = file.digests.sha256.toLowerCase();
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    return err({
      kind: "hash_mismatch",
      spec,
      message: `${file.filename} hashes to sha256:${actual}; the lockfile pins sha256:${expected}`,
    });
  }
  return ok({ filename: file.filename, bytes });
}

/** Remove `<hash>.tmp.<id>` directories older than `STALE_TMP_MS`. Returns their names. */
async function removeStaleTmpDirs(root: string, now: number): Promise<readonly string[]> {
  const dirents = await readdir(root, { withFileTypes: true });
  const candidates = dirents.filter((d) => d.isDirectory() && TMP_DIR_RE.test(d.name));
  const removed: string[] = [];
  for (const d of candidates) {
    const path = join(root, d.name);
    const { mtimeMs } = await stat(path);
    if (now - mtimeMs <= STALE_TMP_MS) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(d.name);
  }
  return removed;
}

export interface ReapTier1WheelDirsArgs {
  wheelsRoot: string;
  /** Lockfile hashes of every skill row, enabled or disabled. */
  reachableHashes: ReadonlySet<string>;
  /** Days a directory must sit unmodified before an unreachable one is removed. */
  graceDays: number;
}

export interface ReapTier1WheelDirsError {
  kind: "reap_failed";
  message: string;
}

/**
 * Remove published wheel directories no skill reaches, once their mtime is
 * older than the grace (design/skills.md → Cache reachability), and `tmp`
 * directories of publishes that died. Only `<sha256 hex>/` directories are
 * candidates; a missing `wheelsRoot` has nothing to reap.
 */
export async function reapTier1WheelDirs(
  args: ReapTier1WheelDirsArgs,
): Promise<Result<{ reapedHashes: readonly string[] }, ReapTier1WheelDirsError>> {
  const now = Date.now();
  const graceMs = args.graceDays * 24 * 60 * 60 * 1000;
  try {
    const dirents = await readdir(args.wheelsRoot, { withFileTypes: true }).catch((e: unknown) => {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
      throw e;
    });
    if (dirents === null) return ok({ reapedHashes: [] });
    const candidates = dirents.filter(
      (d) => d.isDirectory() && HASH_DIR_RE.test(d.name) && !args.reachableHashes.has(d.name),
    );
    const reapedHashes: string[] = [];
    for (const d of candidates) {
      const path = join(args.wheelsRoot, d.name);
      const { mtimeMs } = await stat(path);
      if (now - mtimeMs <= graceMs) continue;
      // A published directory is read-only, so its entries cannot be unlinked until it is writable.
      await chmod(path, 0o755);
      await rm(path, { recursive: true, force: true });
      reapedHashes.push(d.name);
    }
    await removeStaleTmpDirs(args.wheelsRoot, now);
    log.info(
      { reapedCount: reapedHashes.length, reachableCount: args.reachableHashes.size },
      "tier-1 wheel reap completed",
    );
    return ok({ reapedHashes });
  } catch (e) {
    return err({ kind: "reap_failed", message: describeError(e) });
  }
}
