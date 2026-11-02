import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { z } from "zod";
import { logger } from "../logger.js";
import { describeError } from "../util/describe-error.js";
import type { Tier1Prefetcher } from "./worker-wasm/tier1.js";

const log = logger.child({ component: "skills.pyodide-compat" });

const PyodideLockfileSchema = z.object({
  packages: z.record(
    z.string(),
    z.object({
      name: z.string(),
      version: z.string(),
      file_name: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be a lowercase hex digest"),
      depends: z.array(z.string()),
    }),
  ),
});

/** A package Pyodide's distribution ships, keyed by its PEP 503 normalised name. */
export interface BundledPackage {
  version: string;
  /**
   * The package is built for Emscripten (its wheel carries the `…_wasm32`
   * platform tag), so it loads an Emscripten side module rather than only
   * Python source.
   */
  native: boolean;
  /** The file Pyodide loads it from, the name it takes in the package cache. */
  fileName: string;
  /** The hex sha256 the lockfile pins for `fileName`'s bytes. */
  sha256: string;
  /** The bundled packages it needs loaded first, by normalised name. */
  depends: readonly string[];
}

/** Pyodide's `pyodide-lock.json` could not be read or parsed. */
export interface BundledPackagesUnreadable {
  kind: "bundled_unreadable";
  message: string;
}

/** Bundled-package map, lazily loaded from pyodide's installed lockfile. */
let cachedBundled: ReadonlyMap<string, BundledPackage> | null = null;

/**
 * PyPI-pure-wheel cache keyed by `name==version`. Stores only `true`
 * answers: a wheel that exists today won't disappear (PyPI is
 * append-only at the artifact level; yanks hide but don't delete
 * bytes). Skipping `false` caching means a republished version
 * (rare: yank-then-republish, namespace squat takeover) is re-checked
 * on every register instead of pinning the wrong answer for the
 * process lifetime. Cost is one extra PyPI round-trip per
 * register-reject, which is itself rare.
 */
const pypiPureWheelCache = new Map<string, true>();

/**
 * The packages the installed Pyodide distribution bundles, read from its
 * `pyodide-lock.json` (or `lockfilePathOverride`) and cached for the process
 * when read from the installed distribution. Errs when the file is missing or
 * malformed; callers decide whether that blocks them.
 */
export async function loadBundledPackages(
  lockfilePathOverride?: string,
): Promise<Result<ReadonlyMap<string, BundledPackage>, BundledPackagesUnreadable>> {
  if (cachedBundled && !lockfilePathOverride) return ok(cachedBundled);
  let lockPath: string | undefined;
  let raw: unknown;
  try {
    lockPath =
      lockfilePathOverride ?? createRequire(import.meta.url).resolve("pyodide/pyodide-lock.json");
    raw = JSON.parse(await readFile(lockPath, "utf-8"));
  } catch (e) {
    return err({
      kind: "bundled_unreadable",
      message: `${lockPath ?? "pyodide/pyodide-lock.json"}: ${describeError(e)}`,
    });
  }
  const parsed = PyodideLockfileSchema.safeParse(raw);
  if (!parsed.success) {
    return err({
      kind: "bundled_unreadable",
      message: `${lockPath}: not a Pyodide lockfile: ${parsed.error.message}`,
    });
  }
  const map: ReadonlyMap<string, BundledPackage> = new Map(
    Object.values(parsed.data.packages).map((pkg) => [
      normalizePackageName(pkg.name),
      {
        version: pkg.version,
        native: /_wasm32\.whl$/.test(pkg.file_name),
        fileName: pkg.file_name,
        sha256: pkg.sha256,
        depends: pkg.depends.map(normalizePackageName),
      },
    ]),
  );
  if (!lockfilePathOverride) cachedBundled = map;
  return ok(map);
}

/** PEP 503 normalisation — `Foo_Bar.Baz` and `foo-bar-baz` are the same project. */
export function normalizePackageName(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

/** Filename suffixes of a wheel that is pure Python, so importable under Pyodide. */
export const PURE_WHEEL_SUFFIXES = ["-py3-none-any.whl", "-py2.py3-none-any.whl"] as const;

const PypiReleaseSchema = z.object({
  urls: z
    .array(z.object({ packagetype: z.string().optional(), filename: z.string().optional() }))
    .optional(),
});

/** PyPI could not answer: an error status other than 404, a network failure, a timeout. */
export interface PypiUnavailable {
  kind: "pypi_unavailable";
  reason: string;
}

/**
 * Hit PyPI's JSON API for `<name>/<version>`; ok(true) iff at least one
 * wheel artifact has a pure-Python platform tag (importable on any
 * platform Pyodide targets). `bdist_wheel` is the wheel marker; the
 * pure-Python suffix narrows it from a native-binary wheel. A 404 is
 * ok(false); any other failure to get an answer errs, and the caller
 * decides. The lookup is capped at `timeoutMs` so a hung PyPI doesn't
 * block register.
 */
export async function pypiHasPureWheel(
  name: string,
  version: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Result<boolean, PypiUnavailable>> {
  const cacheKey = `${normalizePackageName(name)}==${version}`;
  if (pypiPureWheelCache.has(cacheKey)) return ok(true);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const spec = `${name}==${version}`;
  let body: unknown;
  try {
    const resp = await fetchImpl(
      `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`,
      {
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
        headers: { Accept: "application/json" },
      },
    );
    // Name/version doesn't exist upstream: a legitimate "no pure wheel".
    // Not cached: see `pypiPureWheelCache`.
    if (resp.status === 404) return ok(false);
    if (!resp.ok) {
      return err({ kind: "pypi_unavailable", reason: `pypi http ${resp.status} for ${spec}` });
    }
    body = await resp.json();
  } catch (e) {
    return err({
      kind: "pypi_unavailable",
      reason: `pypi lookup for ${spec}: ${describeError(e)}`,
    });
  }
  const parsed = PypiReleaseSchema.safeParse(body);
  if (!parsed.success) {
    return err({ kind: "pypi_unavailable", reason: `pypi answered ${spec} in an unknown shape` });
  }
  const hasPure = (parsed.data.urls ?? []).some(
    (u) =>
      u.packagetype === "bdist_wheel" &&
      PURE_WHEEL_SUFFIXES.some((suf) => u.filename?.endsWith(suf) === true),
  );
  if (hasPure) pypiPureWheelCache.set(cacheKey, true);
  return ok(hasPure);
}

export type PyodideCompatIssue =
  | {
      spec: string;
      reason: "no_pyodide_bundle_and_no_pure_wheel";
    }
  | {
      spec: string;
      reason: "version_mismatch_no_pure_wheel";
      bundledVersion: string;
    }
  | {
      spec: string;
      reason: "native_package_rejected_by_boundary";
      /** What the probe child reported when the package failed to load. */
      message: string;
    };

/**
 * Load-tests the lockfile's bundled native packages under the tier-1
 * boundary (design/skills.md → Tier-1 boundary, layer 1): Emscripten side
 * modules that define JS with `EM_JS` build it from strings at load, which
 * the boundary refuses.
 */
export interface PyodideBoundaryProbe {
  prefetcher: Tier1Prefetcher;
  packageCacheDir: string;
  signal?: AbortSignal;
}

export interface CheckPyodideCompatOptions {
  /** Override the lockfile path for unit tests. */
  lockfilePath?: string;
  /** Override `fetch` for unit tests. */
  fetchImpl?: typeof fetch;
  /** PyPI lookup wall-clock cap per spec. Defaults to 5s. */
  timeoutMs?: number;
  /** When set, bundled native packages must also load under the boundary. */
  probe?: PyodideBoundaryProbe;
}

/**
 * For each declared `name==version`, verify either (a) Pyodide bundles
 * that exact name+version, or (b) PyPI has a pure-Python wheel for it.
 * Surfaces the "no Pyodide wheel and no pure-Python PyPI wheel" failure
 * mode at register-time, before the first WASM invocation of the skill.
 * Pyodide-incompatible deps should declare `tier: container` instead.
 *
 * With `opts.probe`, the bundled native packages among the specs are then
 * fetched into the package cache and load-tested under the tier-1 boundary;
 * each one that fails to load is a `native_package_rejected_by_boundary`
 * issue.
 *
 * PyPI failures, an unreadable `pyodide-lock.json` and a prefetch that cannot
 * fill the cache fail open with a warn log: a transient outage shouldn't
 * block register, and the first invocation surfaces the same case.
 */
export async function checkPyodideCompat(
  declaredSpecs: ReadonlyArray<string>,
  opts: CheckPyodideCompatOptions = {},
): Promise<Result<void, ReadonlyArray<PyodideCompatIssue>>> {
  if (declaredSpecs.length === 0) return ok();
  const loaded = await loadBundledPackages(opts.lockfilePath);
  if (loaded.isErr()) {
    // pyodide-lock.json unreadable -- typically `pyodide` not installed
    // (a future tier-2-only deployment marking it optional) or the file
    // missing from a non-standard install. Same fail-open posture as
    // PyPI network errors below: register stays unblocked, first
    // WASM-tier invocation surfaces the real issue.
    log.warn(
      { err: loaded.error.message },
      "pyodide-compat: lockfile load failed; allowing register (first-invoke surfaces the real issue)",
    );
    return ok();
  }
  const bundled = loaded.value;
  const parsedSpecs = declaredSpecs.flatMap((spec) => {
    const m = /^([a-z0-9][a-z0-9._-]*?)==(.+)$/i.exec(spec);
    return m?.[1] && m[2] ? [{ spec, name: m[1], version: m[2] }] : [];
  });
  const issues: PyodideCompatIssue[] = [];
  const nativeBundled: { spec: string; name: string }[] = [];
  for (const { spec, name, version } of parsedSpecs) {
    const normName = normalizePackageName(name);
    const pkg = bundled.get(normName);
    if (pkg?.version === version) {
      if (pkg.native) nativeBundled.push({ spec, name: normName });
      continue;
    }
    const pure = await pypiHasPureWheel(name, version, opts);
    if (pure.isErr()) {
      // Fail open: first invoke surfaces the same case, and a brief PyPI
      // outage shouldn't block tier-1 registers.
      log.warn(
        { spec, reason: pure.error.reason },
        "pyodide-compat: PyPI check failed; allowing register (first-invoke will recheck)",
      );
      continue;
    }
    if (pure.value) continue;
    issues.push(
      pkg
        ? { spec, reason: "version_mismatch_no_pure_wheel", bundledVersion: pkg.version }
        : { spec, reason: "no_pyodide_bundle_and_no_pure_wheel" },
    );
  }
  if (opts.probe && nativeBundled.length > 0) {
    issues.push(...(await probeNativeBundled(opts.probe, nativeBundled)));
  }
  return issues.length > 0 ? err(issues) : ok();
}

async function probeNativeBundled(
  probe: PyodideBoundaryProbe,
  packages: ReadonlyArray<{ spec: string; name: string }>,
): Promise<PyodideCompatIssue[]> {
  const names = packages.map((p) => p.name);
  const cacheOpts = {
    packageCacheDir: probe.packageCacheDir,
    ...(probe.signal && { signal: probe.signal }),
  };
  const prefetched = await probe.prefetcher.prefetchBuiltins(names, cacheOpts);
  if (prefetched.isErr()) {
    log.warn(
      { names, reason: prefetched.error },
      "pyodide-compat: package cache prefetch failed; allowing register without the boundary probe",
    );
    return [];
  }
  const probed = await probe.prefetcher.probeBuiltins(names, cacheOpts);
  if (probed.isOk()) return [];
  return (
    match(probed.error)
      .returnType<PyodideCompatIssue[]>()
      .with({ kind: "rejected" }, ({ failures }) =>
        failures.map((failure) => ({
          spec:
            packages.find((p) => p.name === normalizePackageName(failure.name))?.spec ??
            failure.name,
          reason: "native_package_rejected_by_boundary",
          message: failure.reason,
        })),
      )
      // The probe said nothing about the packages: register stays unblocked,
      // and the first run under the boundary surfaces a package that cannot load.
      .with({ kind: "unavailable" }, ({ message }) => {
        log.warn(
          { names, reason: message },
          "pyodide-compat: boundary probe unavailable; allowing register without it",
        );
        return [];
      })
      .exhaustive()
  );
}

/** Render compat issues as a single user-facing message for the register `errors[]`. */
export function formatPyodideCompatIssues(issues: ReadonlyArray<PyodideCompatIssue>): string {
  const lines = issues.map((i) =>
    match(i)
      .with(
        { reason: "version_mismatch_no_pure_wheel" },
        (v) =>
          `tier1_incompatible_dependency: ${v.spec} -- Pyodide bundles ${v.bundledVersion} but no pure-Python wheel exists on PyPI for the requested version`,
      )
      .with(
        { reason: "no_pyodide_bundle_and_no_pure_wheel" },
        (v) =>
          `tier1_incompatible_dependency: ${v.spec} -- not bundled by Pyodide and no pure-Python wheel on PyPI (declare tier: container if a native wheel is required)`,
      )
      .with(
        { reason: "native_package_rejected_by_boundary" },
        (v) =>
          `tier1_incompatible_dependency: ${v.spec} -- its native module cannot load under the tier-1 boundary (JS built from strings); declare tier: container (${v.message})`,
      )
      .exhaustive(),
  );
  return lines.join("; ");
}

/** Test-only: clear in-process caches so unit tests can re-seed bundled state. */
export function __resetPyodideCompatCachesForTests(): void {
  cachedBundled = null;
  pypiPureWheelCache.clear();
}
