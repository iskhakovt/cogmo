import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { logger } from "../logger.js";
import { describeError } from "../util/describe-error.js";

const log = logger.child({ component: "skills.pyodide-compat" });

const PyodideLockfileSchema = z.object({
  packages: z.record(z.string(), z.object({ name: z.string(), version: z.string() })),
});

/** Bundled-package name -> version map, lazily loaded from pyodide's installed lockfile. */
let cachedBundled: Map<string, string> | null = null;

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

async function loadBundled(lockfilePathOverride?: string): Promise<Map<string, string>> {
  if (cachedBundled && !lockfilePathOverride) return cachedBundled;
  const require = createRequire(import.meta.url);
  const lockPath = lockfilePathOverride ?? require.resolve("pyodide/pyodide-lock.json");
  const raw = await readFile(lockPath, "utf-8");
  const parsed = PyodideLockfileSchema.parse(JSON.parse(raw));
  const map = new Map<string, string>();
  for (const pkg of Object.values(parsed.packages)) {
    map.set(normalizeName(pkg.name), pkg.version);
  }
  if (!lockfilePathOverride) cachedBundled = map;
  return map;
}

/** PEP 503 normalisation — `Foo_Bar.Baz` and `foo-bar-baz` are the same project. */
function normalizeName(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

const PURE_WHEEL_SUFFIXES = ["-py3-none-any.whl", "-py2.py3-none-any.whl"] as const;

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
  const cacheKey = `${normalizeName(name)}==${version}`;
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

export interface PyodideCompatIssue {
  spec: string;
  reason: "no_pyodide_bundle_and_no_pure_wheel" | "version_mismatch_no_pure_wheel";
  bundledVersion?: string;
}

export interface CheckPyodideCompatOptions {
  /** Override the lockfile path for unit tests. */
  lockfilePath?: string;
  /** Override `fetch` for unit tests. */
  fetchImpl?: typeof fetch;
  /** PyPI lookup wall-clock cap per spec. Defaults to 5s. */
  timeoutMs?: number;
}

/**
 * For each declared `name==version`, verify either (a) Pyodide bundles
 * that exact name+version, or (b) PyPI has a pure-Python wheel for it
 * (which `micropip.install` can fetch at first invoke). Surfaces the
 * "no Pyodide wheel and no pure-Python PyPI wheel" failure mode at
 * register-time -- otherwise it lands as a confusing micropip exception
 * during the first WASM invocation of the skill. Pyodide-incompatible
 * deps should declare `tier: container` instead.
 *
 * PyPI failures fail open with a warn log: the worst case is
 * first-invoke micropip surface, which is the pre-existing behaviour;
 * we don't want a transient PyPI 503 to block register.
 */
export async function checkPyodideCompat(
  declaredSpecs: ReadonlyArray<string>,
  opts: CheckPyodideCompatOptions = {},
): Promise<Result<void, ReadonlyArray<PyodideCompatIssue>>> {
  if (declaredSpecs.length === 0) return ok();
  let bundled: Map<string, string>;
  try {
    bundled = await loadBundled(opts.lockfilePath);
  } catch (e) {
    // pyodide-lock.json unreadable -- typically `pyodide` not installed
    // (a future tier-2-only deployment marking it optional) or the file
    // missing from a non-standard install. Same fail-open posture as
    // PyPI network errors below: register stays unblocked, first
    // WASM-tier invocation surfaces the real issue via micropip.
    log.warn(
      { err: describeError(e) },
      "pyodide-compat: lockfile load failed; allowing register (first-invoke surfaces the real issue)",
    );
    return ok();
  }
  const issues: PyodideCompatIssue[] = [];
  for (const spec of declaredSpecs) {
    const m = /^([a-z0-9][a-z0-9._-]*?)==(.+)$/i.exec(spec);
    if (!m) continue;
    const name = m[1] ?? "";
    const version = m[2] ?? "";
    if (!name || !version) continue;
    const normName = normalizeName(name);
    const bundledVersion = bundled.get(normName);
    if (bundledVersion === version) continue;
    const pure = await pypiHasPureWheel(name, version, opts);
    if (pure.isErr()) {
      // Fail open: first invoke surfaces the same case via micropip, and a
      // brief PyPI outage shouldn't block tier-1 registers.
      log.warn(
        { spec, reason: pure.error.reason },
        "pyodide-compat: PyPI check failed; allowing register (first-invoke will recheck via micropip)",
      );
      continue;
    }
    if (pure.value) continue;
    issues.push({
      spec,
      reason: bundledVersion
        ? "version_mismatch_no_pure_wheel"
        : "no_pyodide_bundle_and_no_pure_wheel",
      ...(bundledVersion && { bundledVersion }),
    });
  }
  return issues.length > 0 ? err(issues) : ok();
}

/** Render compat issues as a single user-facing message for the register `errors[]`. */
export function formatPyodideCompatIssues(issues: ReadonlyArray<PyodideCompatIssue>): string {
  const lines = issues.map((i) => {
    if (i.reason === "version_mismatch_no_pure_wheel") {
      return `tier1_incompatible_dependency: ${i.spec} -- Pyodide bundles ${i.bundledVersion} but no pure-Python wheel exists on PyPI for the requested version`;
    }
    return `tier1_incompatible_dependency: ${i.spec} -- not bundled by Pyodide and no pure-Python wheel on PyPI (declare tier: container if a native wheel is required)`;
  });
  return lines.join("; ");
}

/** Test-only: clear in-process caches so unit tests can re-seed bundled state. */
export function __resetPyodideCompatCachesForTests(): void {
  cachedBundled = null;
  pypiPureWheelCache.clear();
}
