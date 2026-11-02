import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, Result } from "neverthrow";
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

/** What the sweep meets when a concurrent publisher or sweep moves a candidate first. */
const CONCURRENT_MOVE_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTEMPTY", "EPERM"]);

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
 * while `network_failed`, `prefetch_failed`, `publish_failed` and
 * `bundled_unreadable` (Pyodide's own lockfile could not be read) may clear
 * on a retry. `builtin_integrity` names a package-cache file that does not
 * hash to the sha256 Pyodide's lockfile pins after a prefetch, or that cannot
 * be checked: a verdict on this deployment's cache or its download, not on the
 * skill's lockfile. The mismatching file is deleted, so a retry fetches it again.
 */
export type Tier1PackagesError =
  | { kind: "wheel_unavailable"; spec: string; message: string }
  | { kind: "hash_mismatch"; spec: string; message: string }
  | { kind: "network_failed"; spec: string; message: string }
  | { kind: "prefetch_failed"; message: string }
  | { kind: "publish_failed"; message: string }
  | { kind: "bundled_unreadable"; message: string }
  | { kind: "builtin_integrity"; fileName: string; message: string };

/** A built-in's cache file that cannot be loaded as is: missing, or deleted for bytes other than the lockfile pins. */
type UnverifiedBuiltin =
  | { kind: "absent"; pkg: BundledPackage }
  | { kind: "mismatch"; pkg: BundledPackage; actual: string };

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
 * is a builtin, loaded from `packageCacheDir`; every other package is a
 * pure-Python wheel from PyPI, checked against the lockfile's sha256 and
 * published under `<wheelsRoot>/<lockfile hash>/`.
 *
 * The cache must hold the builtins, micropip (which installs the wheels) and
 * every bundled package they depend on, each file hashing to the sha256
 * Pyodide's lockfile pins. Pyodide's Node loader checks no integrity, of a
 * cached file or of its CDN download, so this check is the one a task child's
 * packages pass. A file that fails it is deleted, and a prefetch child fills
 * the cache only when one of those files is missing or deleted, so a warm
 * cache costs no Pyodide boot; what the prefetch wrote is checked again.
 *
 * The directory is published as the venvs are: written under
 * `<hash>.tmp.<id>`, marked `.ready`, renamed into place, then made
 * read-only. Two publishers of one hash leave one copy; the loser of the
 * rename succeeds once it sees the winner's `.ready`. Nothing in it is a
 * link, since the child's permission model follows links out of the grant.
 */
export async function ensureTier1Packages(
  deps: EnsureTier1PackagesDeps,
  args: EnsureTier1PackagesArgs,
): Promise<Result<Tier1Packages, Tier1PackagesError>> {
  const [builtinEntries, wheelEntries] = R.partition(
    parseLockfileEntries(args.lockfile.contents),
    (e) => deps.bundled.get(normalizePackageName(e.name))?.version === e.version,
  );
  const builtins = builtinEntries.map((e) => normalizePackageName(e.name));
  if (builtins.length === 0 && wheelEntries.length === 0) {
    return ok({ builtins, wheelDir: null });
  }
  const closure = bundledClosure(deps.bundled, [...builtins, "micropip"]);
  const unverified = await evictUnverifiedBuiltins(args.packageCacheDir, closure);
  if (unverified.isErr()) return err(unverified.error);
  if (unverified.value.length > 0) {
    const prefetched = await deps.prefetcher.prefetchBuiltins(builtins, {
      packageCacheDir: args.packageCacheDir,
      ...(args.signal && { signal: args.signal }),
    });
    if (prefetched.isErr()) return err({ kind: "prefetch_failed", message: prefetched.error });
    const rechecked = await evictUnverifiedBuiltins(args.packageCacheDir, closure);
    if (rechecked.isErr()) return err(rechecked.error);
    if (rechecked.value.length > 0) {
      return err(unverifiedAfterPrefetch(args.packageCacheDir, rechecked.value));
    }
  }
  if (wheelEntries.length === 0) return ok({ builtins, wheelDir: null });
  const published = await publishWheelDir(deps.fetchImpl, args, wheelEntries);
  return published.map((wheelDir) => ({ builtins, wheelDir }));
}

/** One line naming why the lockfile's packages could not be made available. */
export function describeTier1PackagesError(error: Tier1PackagesError): string {
  return match(error)
    .with(
      { kind: "wheel_unavailable" },
      { kind: "hash_mismatch" },
      { kind: "network_failed" },
      (e) => `${e.kind}: ${e.spec}: ${e.message}`,
    )
    .with(
      { kind: "prefetch_failed" },
      { kind: "publish_failed" },
      { kind: "bundled_unreadable" },
      (e) => `${e.kind}: ${e.message}`,
    )
    .with({ kind: "builtin_integrity" }, (e) => `${e.kind}: ${e.fileName}: ${e.message}`)
    .exhaustive();
}

/**
 * The bundled packages `roots` name and every bundled package they depend on,
 * transitively. A name Pyodide does not bundle has no file to check.
 */
function bundledClosure(
  bundled: ReadonlyMap<string, BundledPackage>,
  roots: readonly string[],
): readonly BundledPackage[] {
  const seen = new Set<string>();
  const closure: BundledPackage[] = [];
  const pending = [...roots];
  // A stateful walk over the dependency graph, which may share nodes.
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (seen.has(name)) continue;
    seen.add(name);
    const pkg = bundled.get(name);
    if (pkg === undefined) continue;
    closure.push(pkg);
    pending.push(...pkg.depends);
  }
  return closure;
}

/**
 * Hash each package's file in `packageCacheDir` against the sha256 Pyodide's
 * lockfile pins and delete every file that does not match: a truncated write
 * from a prefetch child killed mid-download, or tampered bytes. Resolves to
 * the packages whose file is absent or was deleted; errs `builtin_integrity`
 * when a file can be neither hashed nor deleted.
 */
async function evictUnverifiedBuiltins(
  packageCacheDir: string,
  packages: readonly BundledPackage[],
): Promise<Result<readonly UnverifiedBuiltin[], Tier1PackagesError>> {
  const checked = await Promise.all(packages.map((pkg) => evictIfUnverified(packageCacheDir, pkg)));
  return Result.combine(checked).map((states) => states.filter(R.isNonNullish));
}

/** Null when `pkg`'s cached file hashes to its pinned sha256. */
async function evictIfUnverified(
  packageCacheDir: string,
  pkg: BundledPackage,
): Promise<Result<UnverifiedBuiltin | null, Tier1PackagesError>> {
  const path = join(packageCacheDir, pkg.fileName);
  try {
    const actual = await sha256OfFile(path);
    if (actual === null) return ok({ kind: "absent", pkg });
    if (actual === pkg.sha256) return ok(null);
    await rm(path, { force: true, recursive: true });
    return ok({ kind: "mismatch", pkg, actual });
  } catch (e) {
    return err({
      kind: "builtin_integrity",
      fileName: pkg.fileName,
      message: `cannot check ${path} against its sha256: ${describeError(e)}`,
    });
  }
}

/** The hex sha256 of the file at `path`; null when there is none. */
async function sha256OfFile(path: string): Promise<string | null> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return null;
    throw e;
  }
  return hash.digest("hex");
}

/**
 * The error for the files still failing their check after a prefetch: the
 * first mismatching one, else every absent one.
 */
function unverifiedAfterPrefetch(
  packageCacheDir: string,
  unverified: readonly UnverifiedBuiltin[],
): Tier1PackagesError {
  const mismatch = unverified.find((u) => u.kind === "mismatch");
  if (mismatch !== undefined) {
    return {
      kind: "builtin_integrity",
      fileName: mismatch.pkg.fileName,
      message: `the prefetched file hashes to sha256:${mismatch.actual}; Pyodide's lockfile pins sha256:${mismatch.pkg.sha256}`,
    };
  }
  return {
    kind: "prefetch_failed",
    message: `the prefetch left ${unverified.map((u) => u.pkg.fileName).join(", ")} absent from ${packageCacheDir}`,
  };
}

function errnoCode(e: unknown): string | undefined {
  return e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined;
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
    // The sweep is housekeeping: what it fails to remove waits for the next one.
    await removeStaleTmpDirs(args.wheelsRoot, Date.now()).catch((e: unknown) => {
      log.warn(
        { wheelsRoot: args.wheelsRoot, err: describeError(e) },
        "wheel-cache: stale tmp sweep failed",
      );
    });
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

/**
 * Remove `<hash>.tmp.<id>` directories older than `STALE_TMP_MS`. A candidate
 * a concurrent publisher renames into place, or a concurrent sweep removes,
 * between the listing and its removal is skipped.
 */
async function removeStaleTmpDirs(root: string, now: number): Promise<void> {
  const dirents = await readdir(root, { withFileTypes: true });
  const candidates = dirents.filter((d) => d.isDirectory() && TMP_DIR_RE.test(d.name));
  for (const d of candidates) {
    const path = join(root, d.name);
    try {
      const { mtimeMs } = await stat(path);
      if (now - mtimeMs > STALE_TMP_MS) await removeSealedDir(path);
    } catch (e) {
      const code = errnoCode(e);
      if (code === undefined || !CONCURRENT_MOVE_CODES.has(code)) throw e;
      log.debug({ path, code }, "wheel-cache: tmp dir moved during the sweep");
    }
  }
}

/** Remove a directory that may be sealed read-only: its entries cannot be unlinked until it is writable. */
async function removeSealedDir(dir: string): Promise<void> {
  await chmod(dir, 0o755);
  await rm(dir, { recursive: true, force: true });
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
      if (errnoCode(e) === "ENOENT") return null;
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
      // Out of its hash first, in one rename, so a reader never finds `.ready`
      // over a partial set; a crash before the removal leaves a stale `tmp`
      // directory for the sweep below.
      const doomed = join(args.wheelsRoot, `${d.name}.tmp.${randomUUID()}`);
      await rename(path, doomed);
      await removeSealedDir(doomed);
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
