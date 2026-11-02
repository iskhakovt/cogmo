import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import pyodidePackage from "../../node_modules/pyodide/package.json" with { type: "json" };
import {
  __resetPyodideCompatCachesForTests,
  checkPyodideCompat,
  formatPyodideCompatIssues,
  loadBundledPackages,
  pypiHasPureWheel,
} from "./pyodide-compat.js";
import type { FillBuiltins, Tier1Probe } from "./worker-wasm/tier1.js";

const fakeLockfile = {
  packages: {
    // Exact-version match -> compat accepts without PyPI lookup.
    httpx: {
      name: "httpx",
      version: "0.28.1",
      file_name: "httpx-0.28.1-py3-none-any.whl",
      sha256: "1".repeat(64),
      depends: ["Python_Dateutil"],
    },
    // PEP-503-normalised: stored under `python-dateutil`, queried via `Python_Dateutil` etc.
    "python-dateutil": {
      name: "python-dateutil",
      version: "2.9.0",
      file_name: "python_dateutil-2.9.0-py2.py3-none-any.whl",
      sha256: "2".repeat(64),
      depends: [],
    },
    // Native: an Emscripten-built wheel, as pyodide-lock.json names it.
    "pydantic-core": {
      name: "pydantic_core",
      version: "2.41.5",
      file_name: "pydantic_core-2.41.5-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
      sha256: "3".repeat(64),
      depends: [],
    },
    regex: {
      name: "regex",
      version: "2026.3.32",
      file_name: "regex-2026.3.32-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
      sha256: "4".repeat(64),
      depends: [],
    },
  },
};

let lockfilePath: string;
let lockfileDir: string;

beforeEach(async () => {
  lockfileDir = await mkdtemp(join(tmpdir(), "pyodide-compat-"));
  lockfilePath = join(lockfileDir, "pyodide-lock.json");
  await writeFile(lockfilePath, JSON.stringify(fakeLockfile));
  await writeFile(join(lockfileDir, "package.json"), JSON.stringify({ version: "314.0.7" }));
  __resetPyodideCompatCachesForTests();
});

afterEach(async () => {
  await rm(lockfileDir, { recursive: true, force: true });
});

function fakeFetch(
  responses: Record<string, { ok: boolean; body?: unknown; status?: number }>,
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const m = /\/pypi\/([^/]+)\/([^/]+)\/json/.exec(url);
    if (!m) throw new Error(`unexpected fetch URL: ${url}`);
    const key = `${decodeURIComponent(m[1] ?? "")}==${decodeURIComponent(m[2] ?? "")}`;
    const r = responses[key];
    if (!r) throw new Error(`no fixture for ${key}`);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 404),
      json: async () => r.body ?? {},
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("checkPyodideCompat", () => {
  it("returns ok for empty specs without touching the lockfile or PyPI", async () => {
    const result = await checkPyodideCompat([], { lockfilePath, fetchImpl: fakeFetch({}) });
    expect(result.isOk()).toBe(true);
  });

  it("accepts a spec that exactly matches a Pyodide-bundled version (no PyPI call)", async () => {
    const fetchMock = fakeFetch({});
    const result = await checkPyodideCompat(["httpx==0.28.1"], {
      lockfilePath,
      fetchImpl: fetchMock,
    });
    expect(result.isOk()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a non-bundled spec when PyPI has a pure-Python wheel", async () => {
    const fetchMock = fakeFetch({
      "idna==3.10": {
        ok: true,
        body: { urls: [{ packagetype: "bdist_wheel", filename: "idna-3.10-py3-none-any.whl" }] },
      },
    });
    const result = await checkPyodideCompat(["idna==3.10"], {
      lockfilePath,
      fetchImpl: fetchMock,
    });
    expect(result.isOk()).toBe(true);
  });

  it("rejects a spec that's neither bundled nor pure-Python on PyPI", async () => {
    const fetchMock = fakeFetch({
      "numpy==2.0.0": {
        ok: true,
        body: {
          urls: [
            { packagetype: "bdist_wheel", filename: "numpy-2.0.0-cp312-cp312-linux_x86_64.whl" },
            { packagetype: "sdist", filename: "numpy-2.0.0.tar.gz" },
          ],
        },
      },
    });
    const result = await checkPyodideCompat(["numpy==2.0.0"], {
      lockfilePath,
      fetchImpl: fetchMock,
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error).toHaveLength(1);
    expect(result.error[0]).toMatchObject({
      spec: "numpy==2.0.0",
      reason: "no_pyodide_bundle_and_no_pure_wheel",
    });
  });

  it("rejects a bundled-but-wrong-version spec with `version_mismatch_no_pure_wheel`", async () => {
    const fetchMock = fakeFetch({
      // Suppose 0.27.0 has been yanked / never had a pure wheel.
      "httpx==0.27.0": { ok: true, body: { urls: [] } },
    });
    const result = await checkPyodideCompat(["httpx==0.27.0"], {
      lockfilePath,
      fetchImpl: fetchMock,
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error[0]).toMatchObject({
      spec: "httpx==0.27.0",
      reason: "version_mismatch_no_pure_wheel",
      bundledVersion: "0.28.1",
    });
  });

  it("handles a PyPI 404 as `not pure-Python` (yanked / typo'd name)", async () => {
    const fetchMock = fakeFetch({
      "nonexistent==1.0": { ok: false, status: 404 },
    });
    const result = await checkPyodideCompat(["nonexistent==1.0"], {
      lockfilePath,
      fetchImpl: fetchMock,
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error[0]?.reason).toBe("no_pyodide_bundle_and_no_pure_wheel");
  });

  it("fails open on PyPI network errors (transient blip doesn't block register)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const result = await checkPyodideCompat(["random-pkg==1.0"], {
      lockfilePath,
      fetchImpl: fetchMock,
    });
    // Spec passes -> register unblocked. First-invoke will fail loudly
    // if the dep really is incompatible.
    expect(result.isOk()).toBe(true);
  });

  it("fails open when the Pyodide lockfile itself is unreadable (e.g., pyodide not installed)", async () => {
    // A future tier-2-only deployment could mark `pyodide` optional;
    // `require.resolve` then throws synchronously and the unprotected
    // call would surface as an unfriendly register error. Same
    // fail-open posture as transient PyPI errors -- first-invoke will
    // surface the real issue via micropip.
    const result = await checkPyodideCompat(["any-pkg==1.0"], {
      lockfilePath: "/nonexistent/pyodide-lock.json",
      fetchImpl: fakeFetch({}),
    });
    expect(result.isOk()).toBe(true);
  });

  it("fails open on non-404 PyPI HTTP errors (503/429/etc don't block register)", async () => {
    // Distinct from the 404 case above: a transient 5xx must NOT be
    // cached as "no pure wheel" -- the cache would then pin the wrong
    // answer for the process lifetime and every tier-1 register
    // referencing this package would fail until restart.
    const fetchMock = fakeFetch({
      "blip==1.0": { ok: false, status: 503 },
    });
    const result = await checkPyodideCompat(["blip==1.0"], {
      lockfilePath,
      fetchImpl: fetchMock,
    });
    expect(result.isOk()).toBe(true);
  });

  it("normalises PEP 503 distribution names when checking bundled state", async () => {
    // Lockfile stores under canonical `python-dateutil`; spec uses
    // `Python_Dateutil`. PEP 503 says these are the same project.
    const result = await checkPyodideCompat(["Python_Dateutil==2.9.0"], {
      lockfilePath,
      fetchImpl: fakeFetch({}),
    });
    expect(result.isOk()).toBe(true);
  });

  it("accumulates multiple issues across the dep list (single round-trip per failing spec)", async () => {
    const fetchMock = fakeFetch({
      "numpy==2.0.0": { ok: true, body: { urls: [] } },
      "scipy==1.13.0": { ok: true, body: { urls: [] } },
    });
    const result = await checkPyodideCompat(["numpy==2.0.0", "scipy==1.13.0"], {
      lockfilePath,
      fetchImpl: fetchMock,
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.map((i) => i.spec)).toEqual(["numpy==2.0.0", "scipy==1.13.0"]);
  });
});

describe("loadBundledPackages", () => {
  it("reads the release from the package.json beside the lockfile", async () => {
    expect((await loadBundledPackages(lockfilePath))._unsafeUnwrap().version).toBe("314.0.7");
  });

  it("reads the installed distribution's release, the one its CDN directory is named by", async () => {
    expect((await loadBundledPackages())._unsafeUnwrap().version).toBe(pyodidePackage.version);
  });

  it.each([
    ["missing", null],
    ["not a release", JSON.stringify({ version: "../../evil" })],
  ])("errs bundled_unreadable for a package.json that is %s", async (_label, contents) => {
    const packageJson = join(lockfileDir, "package.json");
    if (contents === null) await rm(packageJson);
    else await writeFile(packageJson, contents);
    expect((await loadBundledPackages(lockfilePath))._unsafeUnwrapErr()).toMatchObject({
      kind: "bundled_unreadable",
      message: expect.stringContaining("package.json"),
    });
  });

  it("keys by normalised name, marks Emscripten-built wheels native, and normalises depends", async () => {
    const bundled = (await loadBundledPackages(lockfilePath))._unsafeUnwrap().packages;
    expect(bundled.get("httpx")).toEqual({
      version: "0.28.1",
      native: false,
      fileName: "httpx-0.28.1-py3-none-any.whl",
      sha256: "1".repeat(64),
      depends: ["python-dateutil"],
    });
    expect(bundled.get("python-dateutil")).toMatchObject({ version: "2.9.0", native: false });
    expect(bundled.get("pydantic-core")).toEqual({
      version: "2.41.5",
      native: true,
      fileName: "pydantic_core-2.41.5-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
      sha256: "3".repeat(64),
      depends: [],
    });
  });

  it("errs bundled_unreadable for a missing file", async () => {
    const result = await loadBundledPackages(join(lockfileDir, "missing.json"));
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "bundled_unreadable",
      message: expect.stringContaining("missing.json"),
    });
  });

  it("errs bundled_unreadable for a file that is not a Pyodide lockfile", async () => {
    await writeFile(lockfilePath, JSON.stringify({ packages: { x: { name: "x" } } }));
    const result = await loadBundledPackages(lockfilePath);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "bundled_unreadable",
      message: expect.stringContaining("not a Pyodide lockfile"),
    });
  });

  it("errs bundled_unreadable for an entry whose sha256 is not a hex digest", async () => {
    const { httpx } = fakeLockfile.packages;
    await writeFile(
      lockfilePath,
      JSON.stringify({ packages: { httpx: { ...httpx, sha256: "not-a-digest" } } }),
    );
    expect((await loadBundledPackages(lockfilePath))._unsafeUnwrapErr()).toMatchObject({
      kind: "bundled_unreadable",
      message: expect.stringContaining("sha256"),
    });
  });

  it("errs bundled_unreadable for a file that is not JSON", async () => {
    await writeFile(lockfilePath, "{ cut short");
    expect((await loadBundledPackages(lockfilePath))._unsafeUnwrapErr().kind).toBe(
      "bundled_unreadable",
    );
  });
});

describe("checkPyodideCompat boundary probe", () => {
  /** A boundary probe whose cache fill succeeds unless told otherwise. */
  function boundary() {
    const fillBuiltins = vi.fn<FillBuiltins>(async () => ok());
    const probe = mock<Tier1Probe>();
    return { fillBuiltins, probe, packageCacheDir: "/cache/pyodide" };
  }

  it("fills the cache with and probes only the bundled native packages", async () => {
    const b = boundary();
    b.probe.probeBuiltins.mockResolvedValue(ok());
    const result = await checkPyodideCompat(
      ["httpx==0.28.1", "pydantic_core==2.41.5", "regex==2026.3.32"],
      { lockfilePath, fetchImpl: fakeFetch({}), probe: b },
    );
    expect(result.isOk()).toBe(true);
    expect(b.fillBuiltins).toHaveBeenCalledWith(["pydantic-core", "regex"], {
      packageCacheDir: "/cache/pyodide",
    });
    expect(b.probe.probeBuiltins).toHaveBeenCalledWith(["pydantic-core", "regex"], {
      packageCacheDir: "/cache/pyodide",
    });
  });

  it("allows the register when the probe itself could not run", async () => {
    const b = boundary();
    b.probe.probeBuiltins.mockResolvedValue(
      err({ kind: "unavailable", message: "probe child exited with code 137" }),
    );
    const result = await checkPyodideCompat(["pydantic_core==2.41.5"], {
      lockfilePath,
      fetchImpl: fakeFetch({}),
      probe: b,
    });
    expect(result.isOk()).toBe(true);
  });

  it("turns each package the probe rejects into an issue carrying its message", async () => {
    const b = boundary();
    b.probe.probeBuiltins.mockResolvedValue(
      err({
        kind: "rejected",
        failures: [{ name: "regex", reason: "EvalError: Code generation from strings disallowed" }],
      }),
    );
    const result = await checkPyodideCompat(["pydantic_core==2.41.5", "regex==2026.3.32"], {
      lockfilePath,
      fetchImpl: fakeFetch({}),
      probe: b,
    });
    expect(result._unsafeUnwrapErr()).toEqual([
      {
        spec: "regex==2026.3.32",
        reason: "native_package_rejected_by_boundary",
        message: "EvalError: Code generation from strings disallowed",
      },
    ]);
    expect(formatPyodideCompatIssues(result._unsafeUnwrapErr())).toBe(
      "tier1_incompatible_dependency: regex==2026.3.32 -- its native module cannot load under the tier-1 boundary (JS built from strings); declare tier: container (EvalError: Code generation from strings disallowed)",
    );
  });

  it("does not start a probe when no native package is bundled at its locked version", async () => {
    const b = boundary();
    const result = await checkPyodideCompat(["httpx==0.28.1"], {
      lockfilePath,
      fetchImpl: fakeFetch({}),
      probe: b,
    });
    expect(result.isOk()).toBe(true);
    expect(b.fillBuiltins).not.toHaveBeenCalled();
    expect(b.probe.probeBuiltins).not.toHaveBeenCalled();
  });

  it("fails open when the package cache cannot be filled", async () => {
    const b = boundary();
    b.fillBuiltins.mockResolvedValue(
      err({ kind: "prefetch_failed", message: "download https://cdn.jsdelivr.net/…: ECONNRESET" }),
    );
    const result = await checkPyodideCompat(["regex==2026.3.32"], {
      lockfilePath,
      fetchImpl: fakeFetch({}),
      probe: b,
    });
    expect(result.isOk()).toBe(true);
    expect(b.probe.probeBuiltins).not.toHaveBeenCalled();
  });

  it("reports probe rejections beside the PyPI issues", async () => {
    const b = boundary();
    b.probe.probeBuiltins.mockResolvedValue(
      err({ kind: "rejected", failures: [{ name: "regex", reason: "boom" }] }),
    );
    const result = await checkPyodideCompat(["numpy==2.0.0", "regex==2026.3.32"], {
      lockfilePath,
      fetchImpl: fakeFetch({ "numpy==2.0.0": { ok: true, body: { urls: [] } } }),
      probe: b,
    });
    expect(result._unsafeUnwrapErr().map((i) => i.reason)).toEqual([
      "no_pyodide_bundle_and_no_pure_wheel",
      "native_package_rejected_by_boundary",
    ]);
  });
});

describe("pypiHasPureWheel", () => {
  it("caches `true` results across calls (one HTTP roundtrip per pure-wheel hit)", async () => {
    const fetchMock = fakeFetch({
      "x==1.0": {
        ok: true,
        body: { urls: [{ packagetype: "bdist_wheel", filename: "x-1.0-py3-none-any.whl" }] },
      },
    });
    const a = await pypiHasPureWheel("x", "1.0", { fetchImpl: fetchMock });
    const b = await pypiHasPureWheel("x", "1.0", { fetchImpl: fetchMock });
    expect(a._unsafeUnwrap()).toBe(true);
    expect(b._unsafeUnwrap()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache `false` results (republished pure-wheel becomes visible after first miss)", async () => {
    // Yank-then-republish, namespace-squat takeover, and similar
    // edge cases would otherwise pin the wrong answer for process
    // lifetime. The cost is one extra round-trip per register-reject
    // (a rare path).
    let urls: Array<{ packagetype: string; filename: string }> = [];
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ urls }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const first = await pypiHasPureWheel("rare", "1.0", { fetchImpl: fetchMock });
    expect(first._unsafeUnwrap()).toBe(false);
    urls = [{ packagetype: "bdist_wheel", filename: "rare-1.0-py3-none-any.whl" }];
    const second = await pypiHasPureWheel("rare", "1.0", { fetchImpl: fetchMock });
    expect(second._unsafeUnwrap()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts the universal py2.py3 wheel suffix", async () => {
    const fetchMock = fakeFetch({
      "y==1.0": {
        ok: true,
        body: { urls: [{ packagetype: "bdist_wheel", filename: "y-1.0-py2.py3-none-any.whl" }] },
      },
    });
    expect((await pypiHasPureWheel("y", "1.0", { fetchImpl: fetchMock }))._unsafeUnwrap()).toBe(
      true,
    );
  });

  it("errs pypi_unavailable on a non-404 error status", async () => {
    const fetchMock = fakeFetch({ "z==1.0": { ok: false, status: 503 } });
    const result = await pypiHasPureWheel("z", "1.0", { fetchImpl: fetchMock });
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "pypi_unavailable",
      reason: "pypi http 503 for z==1.0",
    });
  });

  it("errs pypi_unavailable when the request itself fails", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await pypiHasPureWheel("w", "1.0", { fetchImpl: fetchMock });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "pypi_unavailable",
      reason: expect.stringContaining("fetch failed"),
    });
  });

  it("errs pypi_unavailable on a body that is not a release", async () => {
    const fetchMock = fakeFetch({ "v==1.0": { ok: true, body: { urls: "nope" } } });
    const result = await pypiHasPureWheel("v", "1.0", { fetchImpl: fetchMock });
    expect(result._unsafeUnwrapErr().kind).toBe("pypi_unavailable");
  });
});

describe("formatPyodideCompatIssues", () => {
  it("renders multiple issues on a single line with `; ` separator", () => {
    const msg = formatPyodideCompatIssues([
      { spec: "numpy==2.0.0", reason: "no_pyodide_bundle_and_no_pure_wheel" },
      { spec: "httpx==0.27.0", reason: "version_mismatch_no_pure_wheel", bundledVersion: "0.28.1" },
    ]);
    expect(msg).toContain("numpy==2.0.0");
    expect(msg).toContain("httpx==0.27.0");
    expect(msg).toContain("Pyodide bundles 0.28.1");
    expect(msg).toContain("; ");
  });
});
