import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { err, ok, Result } from "neverthrow";
import * as R from "remeda";
import { z } from "zod";
import { logger } from "../../logger.js";
import { describeError } from "../../util/describe-error.js";
import { type LockfileEntry, type LockfileSnapshot, parseLockfileEntries } from "../deps.js";
import {
  type BundledDistribution,
  type BundledPackage,
  normalizePackageName,
  PURE_WHEEL_SUFFIXES,
  PYODIDE_VERSION_PATTERN,
} from "../pyodide-compat.js";
import type { Tier1Packages, Tier1PackagesError } from "./tier1.js";

const log = logger.child({ component: "skills.wheel-cache" });

/** A published wheel directory: `<lockfile sha256>-pyodide<release>` ({@link wheelDirName}). */
const WHEEL_DIR_RE = new RegExp(`^[0-9a-f]{64}-pyodide${PYODIDE_VERSION_PATTERN}$`);

/** An in-flight publish, or a reap's doomed directory: `<wheel dir>.tmp.<id>`. */
const TMP_DIR_RE = new RegExp(`^[0-9a-f]{64}-pyodide${PYODIDE_VERSION_PATTERN}\\.tmp\\.`);

/** A `tmp` directory this old belongs to a publish or a cache fill that died. */
const STALE_TMP_MS = 10 * 60 * 1000;

/** What the sweep meets when a concurrent publisher or sweep moves a candidate first. */
const CONCURRENT_MOVE_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTEMPTY", "EPERM"]);

/**
 * Wall-clock cap on each request: a PyPI metadata lookup, a wheel download,
 * a built-in's download from Pyodide's CDN.
 */
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

/** What the host fetches a lockfile's tier-1 packages with. */
export interface Tier1PackageSource {
  /** Reaches Pyodide's CDN for the built-ins and PyPI for the wheels. */
  fetchImpl: typeof fetch;
  /** The installed Pyodide distribution (`loadBundledPackages`). */
  bundled: BundledDistribution;
}

export interface FillBuiltinCacheArgs {
  /** Bundled packages to provide, by normalised name; micropip is always among them. */
  names: readonly string[];
  /** Pyodide's package cache, which tier-1 children load from. */
  packageCacheDir: string;
  signal?: AbortSignal;
}

export interface EnsureTier1PackagesArgs {
  lockfile: LockfileSnapshot;
  /** Pyodide's package cache, which `fillBuiltinCache` fills. */
  packageCacheDir: string;
  /** Parent of the per-lockfile, per-Pyodide-release wheel directories. */
  wheelsRoot: string;
  signal?: AbortSignal;
}

/**
 * Provide what a tier-1 child installs for `lockfile` (design/skills.md →
 * Tier-1 boundary, layer 4). A package Pyodide bundles at the locked version
 * is a builtin, loaded from `packageCacheDir`; every other package is a
 * pure-Python wheel from PyPI, checked against the lockfile's sha256 and
 * published under `<wheelsRoot>/<lockfile hash>-pyodide<release>/`. The
 * release is in the key because it decides which packages are builtins: after
 * a Pyodide bump, a package that left the bundle needs a directory that
 * carries its wheel.
 *
 * The builtins come from `fillBuiltinCache`.
 *
 * The directory is published as the venvs are: written under
 * `<key>.tmp.<id>`, marked `.ready`, renamed into place, then made
 * read-only. Two publishers of one key leave one copy; the loser of the
 * rename succeeds once it sees the winner's `.ready`. Nothing in it is a
 * link, since the child's permission model follows links out of the grant.
 */
export async function ensureTier1Packages(
  deps: Tier1PackageSource,
  args: EnsureTier1PackagesArgs,
): Promise<Result<Tier1Packages, Tier1PackagesError>> {
  const [builtinEntries, wheelEntries] = R.partition(
    parseLockfileEntries(args.lockfile.contents),
    (e) => deps.bundled.packages.get(normalizePackageName(e.name))?.version === e.version,
  );
  const builtins = builtinEntries.map((e) => normalizePackageName(e.name));
  if (builtins.length === 0 && wheelEntries.length === 0) {
    return ok({ builtins, wheelDir: null });
  }
  const filled = await fillBuiltinCache(deps, {
    names: builtins,
    packageCacheDir: args.packageCacheDir,
    ...(args.signal && { signal: args.signal }),
  });
  if (filled.isErr()) return err(filled.error);
  if (wheelEntries.length === 0) return ok({ builtins, wheelDir: null });
  const published = await publishWheelDir(deps, args, wheelEntries);
  return published.map((wheelDir) => ({ builtins, wheelDir }));
}

/**
 * Make `packageCacheDir` hold `names`, micropip (which installs the wheels)
 * and every bundled package they depend on, each file hashing to the sha256
 * Pyodide's lockfile pins. Pyodide's Node loader checks no integrity, of a
 * cached file or of its CDN download, so this check is the one a child's
 * packages pass. A cached file that fails it is deleted.
 *
 * The host downloads each missing file itself from Pyodide's CDN, the URL
 * Pyodide's loader uses (`v<release>/full/<file>`), and hashes it in memory;
 * no Pyodide boots and no downloaded byte runs. Only once every download
 * matches its pin are they written to a private staging directory beside the
 * cache (`<packageCacheDir>.tmp.<id>`, `0o700`) and each renamed into the
 * cache. A rename replaces a file whole and a reader holding the old one
 * keeps it, so concurrent resolutions, in this process or another, only ever
 * see whole files in the cache. A download that fails its pin errs
 * `builtin_integrity` naming the file; one that cannot be had errs
 * `prefetch_failed`. Either way nothing reaches the cache.
 */
export async function fillBuiltinCache(
  deps: Tier1PackageSource,
  args: FillBuiltinCacheArgs,
): Promise<Result<void, Tier1PackagesError>> {
  const closure = bundledClosure(deps.bundled.packages, [...args.names, "micropip"]);
  const unverified = await evictUnverifiedBuiltins(args.packageCacheDir, closure);
  if (unverified.isErr()) return err(unverified.error);
  if (unverified.value.length === 0) return ok();
  const downloads = Result.combine(
    await Promise.all(
      unverified.value.map((pkg) =>
        downloadVerifiedBuiltin(deps.fetchImpl, deps.bundled.version, pkg, args.signal),
      ),
    ),
  );
  if (downloads.isErr()) return err(downloads.error);
  return stageIntoCache(args.packageCacheDir, downloads.value);
}

/** The URL Pyodide's loader fetches `fileName` of `version` from. */
function pyodideCdnUrl(version: string, fileName: string): string {
  return `https://cdn.jsdelivr.net/pyodide/v${version}/full/${encodeURIComponent(fileName)}`;
}

/** `pkg`'s file from Pyodide's CDN, held in memory once it hashes to its pinned sha256. */
async function downloadVerifiedBuiltin(
  fetchImpl: typeof fetch,
  version: string,
  pkg: BundledPackage,
  signal: AbortSignal | undefined,
): Promise<Result<{ pkg: BundledPackage; bytes: Buffer }, Tier1PackagesError>> {
  const url = pyodideCdnUrl(version, pkg.fileName);
  let bytes: Buffer;
  try {
    const resp = await fetchImpl(url, { signal: requestSignal(signal) });
    if (!resp.ok) {
      return err({ kind: "prefetch_failed", message: `http ${resp.status} for ${url}` });
    }
    bytes = Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    return err({ kind: "prefetch_failed", message: `download ${url}: ${describeError(e)}` });
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== pkg.sha256) {
    return err({
      kind: "builtin_integrity",
      fileName: pkg.fileName,
      message: `the download from ${url} hashes to sha256:${actual}; Pyodide's lockfile pins sha256:${pkg.sha256}`,
    });
  }
  return ok({ pkg, bytes });
}

/** Write verified `downloads` to a private staging directory beside the cache, then rename each into it. */
async function stageIntoCache(
  cacheDir: string,
  downloads: readonly { pkg: BundledPackage; bytes: Buffer }[],
): Promise<Result<void, Tier1PackagesError>> {
  const stagingPrefix = `${basename(cacheDir)}.tmp.`;
  const staging = `${cacheDir}.tmp.${randomUUID()}`;
  try {
    await mkdir(cacheDir, { recursive: true });
    await removeStaleTmpDirs(
      dirname(cacheDir),
      (name) => name.startsWith(stagingPrefix),
      Date.now(),
    ).catch((e: unknown) => {
      log.warn({ cacheDir, err: describeError(e) }, "wheel-cache: stale staging sweep failed");
    });
    await mkdir(staging, { mode: 0o700 });
    await Promise.all(
      downloads.map(({ pkg, bytes }) =>
        writeFile(join(staging, pkg.fileName), bytes, { flag: "wx" }),
      ),
    );
    await Promise.all(
      downloads.map(({ pkg }) => rename(join(staging, pkg.fileName), join(cacheDir, pkg.fileName))),
    );
    return ok();
  } catch (e) {
    return err({
      kind: "prefetch_failed",
      message: `staging the download in ${staging}: ${describeError(e)}`,
    });
  } finally {
    // Empty after the renames; the remains of a failed write otherwise.
    await rm(staging, { recursive: true, force: true }).catch((e: unknown) => {
      log.warn({ staging, err: describeError(e) }, "wheel-cache: staging dir cleanup failed");
    });
  }
}

/** The signal each request runs under: the caller's, capped at `REQUEST_TIMEOUT_MS`. */
function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
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
 * lockfile pins and delete every file that does not match: tampered or
 * damaged bytes. Resolves to the packages whose file is absent or was
 * deleted; errs `builtin_integrity` when a file can be neither hashed nor
 * deleted.
 */
async function evictUnverifiedBuiltins(
  packageCacheDir: string,
  packages: readonly BundledPackage[],
): Promise<Result<readonly BundledPackage[], Tier1PackagesError>> {
  const checked = await Promise.all(packages.map((pkg) => evictIfUnverified(packageCacheDir, pkg)));
  return Result.combine(checked).map((states) => states.filter(R.isNonNullish));
}

/** `pkg` when its cached file is absent or was deleted; null when it hashes to its pinned sha256. */
async function evictIfUnverified(
  packageCacheDir: string,
  pkg: BundledPackage,
): Promise<Result<BundledPackage | null, Tier1PackagesError>> {
  const path = join(packageCacheDir, pkg.fileName);
  try {
    const actual = await sha256OfFile(path);
    if (actual === null) return ok(pkg);
    if (actual === pkg.sha256) return ok(null);
    await rm(path, { force: true, recursive: true });
    log.warn(
      { path, actual, pinned: pkg.sha256 },
      "wheel-cache: deleted a cached built-in that fails its pinned sha256",
    );
    return ok(pkg);
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

function errnoCode(e: unknown): string | undefined {
  return e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined;
}

/** Files `0o444`, then the directory `0o555`: what the permission grant lets a child read and nothing writes. */
async function sealReadOnly(target: string): Promise<void> {
  const names = await readdir(target);
  await Promise.all(names.map((name) => chmod(join(target, name), 0o444)));
  await chmod(target, 0o555);
}

/** The wheel directory's name for a lockfile under a Pyodide release. */
function wheelDirName(lockfileHash: string, pyodideVersion: string): string {
  return `${lockfileHash}-pyodide${pyodideVersion}`;
}

async function publishWheelDir(
  deps: Tier1PackageSource,
  args: EnsureTier1PackagesArgs,
  entries: readonly LockfileEntry[],
): Promise<Result<string, Tier1PackagesError>> {
  const key = wheelDirName(args.lockfile.hash, deps.bundled.version);
  if (!WHEEL_DIR_RE.test(key)) {
    throw new Error(`ensureTier1Packages: ${key} is not a sha256 hex digest and a Pyodide release`);
  }
  const target = join(args.wheelsRoot, key);
  if (await isReady(target)) {
    // A publisher that died between its rename and its chmod left the
    // directory writable; sealing is idempotent, so every reader re-applies it.
    await sealReadOnly(target);
    return ok(target);
  }

  const tmp = join(args.wheelsRoot, `${key}.tmp.${randomUUID()}`);
  try {
    await mkdir(args.wheelsRoot, { recursive: true });
    // The sweep is housekeeping: what it fails to remove waits for the next one.
    await removeStaleTmpDirs(args.wheelsRoot, isWheelTmpDir, Date.now()).catch((e: unknown) => {
      log.warn(
        { wheelsRoot: args.wheelsRoot, err: describeError(e) },
        "wheel-cache: stale tmp sweep failed",
      );
    });
    await mkdir(tmp);
    for (const entry of entries) {
      const wheel = await fetchVerifiedWheel(deps.fetchImpl, entry, args.signal);
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
  let body: unknown;
  try {
    const resp = await fetchImpl(
      `https://pypi.org/pypi/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}/json`,
      { headers: { Accept: "application/json" }, signal: requestSignal(signal) },
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
    const resp = await fetchImpl(file.url, { signal: requestSignal(signal) });
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

function isWheelTmpDir(name: string): boolean {
  return TMP_DIR_RE.test(name);
}

/**
 * Remove the directories under `root` that `isTmp` names and that are older
 * than `STALE_TMP_MS`. A candidate a concurrent publisher renames into place,
 * or a concurrent sweep removes, between the listing and its removal is
 * skipped.
 */
async function removeStaleTmpDirs(
  root: string,
  isTmp: (name: string) => boolean,
  now: number,
): Promise<void> {
  const dirents = await readdir(root, { withFileTypes: true });
  const candidates = dirents.filter((d) => d.isDirectory() && isTmp(d.name));
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

/**
 * Rename `path` to `doomed` if its mtime is before `cutoffMs`. False when it
 * is newer, or when a concurrent publisher or reap moved it first.
 */
async function moveOutIfStale(path: string, doomed: string, cutoffMs: number): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(path);
    if (mtimeMs >= cutoffMs) return false;
    await rename(path, doomed);
    return true;
  } catch (e) {
    const code = errnoCode(e);
    if (code === undefined || !CONCURRENT_MOVE_CODES.has(code)) throw e;
    log.debug({ path, code }, "wheel-cache: wheel dir moved during the reap");
    return false;
  }
}

export interface ReapTier1WheelDirsArgs {
  wheelsRoot: string;
  /** Lockfile hashes of every skill row, enabled or disabled. */
  reachableHashes: ReadonlySet<string>;
  /**
   * The installed Pyodide's release. A reachable hash's directory for any
   * other release is one no child installs from, so it ages out like an
   * unreachable one.
   */
  pyodideVersion: string;
  /** Days a directory must sit unmodified before an unreachable one is removed. */
  graceDays: number;
}

export interface ReapTier1WheelDirsError {
  kind: "reap_failed";
  message: string;
}

/**
 * Remove published wheel directories no skill reaches under the installed
 * Pyodide release, once their mtime is older than the grace (design/skills.md
 * → Cache reachability), and `tmp` directories of publishes that died. Only
 * `<sha256 hex>-pyodide<release>/` directories are candidates, and only
 * `<reachable hash>-pyodide<installed release>/` ones are kept; a missing
 * `wheelsRoot` has nothing to reap.
 */
/**
 * Remove the wheel root's stale `*.tmp.*` directories alone, for a reaper that
 * cannot tell which release is installed and so cannot judge the published
 * directories: publish leftovers must not pile up behind a metadata failure.
 */
export async function sweepTier1WheelTmpDirs(
  wheelsRoot: string,
): Promise<Result<void, ReapTier1WheelDirsError>> {
  try {
    await removeStaleTmpDirs(wheelsRoot, isWheelTmpDir, Date.now());
    return ok();
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return ok();
    return err({ kind: "reap_failed", message: describeError(e) });
  }
}

export async function reapTier1WheelDirs(
  args: ReapTier1WheelDirsArgs,
): Promise<Result<{ reapedDirs: readonly string[] }, ReapTier1WheelDirsError>> {
  const now = Date.now();
  const graceMs = args.graceDays * 24 * 60 * 60 * 1000;
  try {
    const dirents = await readdir(args.wheelsRoot, { withFileTypes: true }).catch((e: unknown) => {
      if (errnoCode(e) === "ENOENT") return null;
      throw e;
    });
    if (dirents === null) return ok({ reapedDirs: [] });
    const reachableDirs = new Set(
      [...args.reachableHashes].map((hash) => wheelDirName(hash, args.pyodideVersion)),
    );
    const candidates = dirents.filter(
      (d) => d.isDirectory() && WHEEL_DIR_RE.test(d.name) && !reachableDirs.has(d.name),
    );
    const reapedDirs: string[] = [];
    for (const d of candidates) {
      const path = join(args.wheelsRoot, d.name);
      // Out of its key first, in one rename, so a reader never finds
      // `.ready` over a partial set; a crash before the removal leaves a
      // stale `tmp` directory for the sweep below.
      const doomed = join(args.wheelsRoot, `${d.name}.tmp.${randomUUID()}`);
      const moved = await moveOutIfStale(path, doomed, now - graceMs);
      if (!moved) continue;
      // A removal that fails may leave the directory behind, so it fails the reap.
      await removeSealedDir(doomed);
      reapedDirs.push(d.name);
    }
    await removeStaleTmpDirs(args.wheelsRoot, isWheelTmpDir, now);
    log.info(
      { reapedCount: reapedDirs.length, reachableCount: reachableDirs.size },
      "tier-1 wheel reap completed",
    );
    return ok({ reapedDirs });
  } catch (e) {
    return err({ kind: "reap_failed", message: describeError(e) });
  }
}
