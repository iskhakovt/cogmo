import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPyodideCompatCachesForTests,
  checkPyodideCompat,
  formatPyodideCompatIssues,
  pypiHasPureWheel,
} from "./pyodide-compat.js";

const fakeLockfile = {
  packages: {
    // Exact-version match -> compat accepts without PyPI lookup.
    httpx: { name: "httpx", version: "0.28.1" },
    // PEP-503-normalised: stored under `python-dateutil`, queried via `Python_Dateutil` etc.
    "python-dateutil": { name: "python-dateutil", version: "2.9.0" },
  },
};

let lockfilePath: string;
let lockfileDir: string;

beforeEach(async () => {
  lockfileDir = await mkdtemp(join(tmpdir(), "pyodide-compat-"));
  lockfilePath = join(lockfileDir, "pyodide-lock.json");
  await writeFile(lockfilePath, JSON.stringify(fakeLockfile));
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

describe("pypiHasPureWheel", () => {
  it("caches results across calls (same `name==version` -> one HTTP roundtrip)", async () => {
    const fetchMock = fakeFetch({
      "x==1.0": {
        ok: true,
        body: { urls: [{ packagetype: "bdist_wheel", filename: "x-1.0-py3-none-any.whl" }] },
      },
    });
    const a = await pypiHasPureWheel("x", "1.0", { fetchImpl: fetchMock });
    const b = await pypiHasPureWheel("x", "1.0", { fetchImpl: fetchMock });
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts the universal py2.py3 wheel suffix", async () => {
    const fetchMock = fakeFetch({
      "y==1.0": {
        ok: true,
        body: { urls: [{ packagetype: "bdist_wheel", filename: "y-1.0-py2.py3-none-any.whl" }] },
      },
    });
    expect(await pypiHasPureWheel("y", "1.0", { fetchImpl: fetchMock })).toBe(true);
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
