import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashLockfileContents, type LockfileSnapshot } from "../deps.js";
import type { BundledDistribution, BundledPackage } from "../pyodide-compat.js";
import { ensureWasmPackages, reapWasmWheelDirs } from "./wheel-cache.js";

/** Runs before each `stat` the module under test makes, to stage a concurrent writer. */
const statHook = vi.hoisted(() => {
  const hook: { before: ((path: string) => Promise<void>) | null } = { before: null };
  return hook;
});

/** Runs before each `rm`, to fail a removal. */
const rmHook = vi.hoisted(() => {
  const hook: { before: ((path: string) => Promise<void>) | null } = { before: null };
  return hook;
});

/** Runs before each `rename`, to observe a staging directory before it empties. */
const renameHook = vi.hoisted(() => {
  const hook: { before: ((from: string) => Promise<void>) | null } = { before: null };
  return hook;
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      await statHook.before?.(args[0].toString());
      return actual.stat(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await rmHook.before?.(args[0].toString());
      return actual.rm(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await renameHook.before?.(args[0].toString());
      return actual.rename(...args);
    },
  };
});

const IDNA_BYTES = Buffer.from("idna wheel bytes");
const SNIFFIO_BYTES = Buffer.from("sniffio wheel bytes");

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const IDNA_SHA = sha256(IDNA_BYTES);
const SNIFFIO_SHA = sha256(SNIFFIO_BYTES);
const OTHER_SHA = "f".repeat(64);

const PYODIDE_VERSION = "314.0.7";
const CDN_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/** A wheel directory's name under `version`. */
function wheelKeyAt(lockfileHash: string, version: string): string {
  return `${lockfileHash}-pyodide${version}`;
}

/** A wheel directory's name under the fixture's Pyodide release. */
function wheelKey(lockfileHash: string): string {
  return wheelKeyAt(lockfileHash, PYODIDE_VERSION);
}

/** The bytes a bundled fixture's file holds, which its lockfile sha256 pins. */
function bundledBytes(fileName: string): Buffer {
  return Buffer.from(`${fileName} bytes`);
}

function bundled(version: string, fileName: string, depends: readonly string[]): BundledPackage {
  return {
    version,
    native: fileName.includes("_wasm32"),
    fileName,
    sha256: sha256(bundledBytes(fileName)),
    depends,
  };
}

function bundledFileName(name: string): string {
  const pkg = BUNDLED.packages.get(name);
  if (pkg === undefined) throw new Error(`no bundled fixture ${name}`);
  return pkg.fileName;
}

const BUNDLED: BundledDistribution = {
  version: PYODIDE_VERSION,
  packages: new Map([
    [
      "pydantic",
      bundled("2.12.5", "pydantic-2.12.5-py3-none-any.whl", ["pydantic-core", "typing-extensions"]),
    ],
    [
      "pydantic-core",
      bundled("2.41.5", "pydantic_core-2.41.5-cp314-cp314-pyemscripten_2026_0_wasm32.whl", [
        "typing-extensions",
      ]),
    ],
    ["typing-extensions", bundled("4.15.0", "typing_extensions-4.15.0-py3-none-any.whl", [])],
    ["micropip", bundled("0.11.1", "micropip-0.11.1-py3-none-any.whl", [])],
  ]),
};

/** The closure of `pydantic`: what a cold cache fetches for a lockfile pinning it. */
const PYDANTIC_CLOSURE = ["pydantic", "pydantic-core", "typing-extensions", "micropip"];

/** A package cache holding the lockfile-pinned files of `names`. */
async function cacheWith(dir: string, names: readonly string[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (const name of names) {
    const fileName = bundledFileName(name);
    await writeFile(join(dir, fileName), bundledBytes(fileName));
  }
  return dir;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function lockfile(contents: string): LockfileSnapshot {
  return { hash: hashLockfileContents(contents), contents };
}

const MIXED_LOCK = lockfile(`idna==3.10 \\
    --hash=sha256:${IDNA_SHA}
pydantic==2.12.5 \\
    --hash=sha256:${OTHER_SHA}
pydantic-core==2.41.5 \\
    --hash=sha256:${OTHER_SHA}
`);

const PYDANTIC_LOCK = lockfile(`pydantic==2.12.5 --hash=sha256:${OTHER_SHA}\n`);

interface ReleaseFile {
  packagetype: string;
  filename: string;
  url: string;
  digests: { sha256: string };
}

function pureWheel(name: string, version: string, digest: string): ReleaseFile {
  return {
    packagetype: "bdist_wheel",
    filename: `${name}-${version}-py3-none-any.whl`,
    url: `https://files.pythonhosted.org/packages/${name}-${version}-py3-none-any.whl`,
    digests: { sha256: digest },
  };
}

/** Pyodide's CDN serving every bundled fixture's pinned bytes, by file name. */
function pinnedCdn(): Record<string, Buffer | number> {
  return Object.fromEntries(
    [...BUNDLED.packages.values()].map((pkg) => [pkg.fileName, bundledBytes(pkg.fileName)]),
  );
}

/**
 * PyPI and Pyodide's CDN by URL: release JSON keyed `name==version`, wheel
 * bytes keyed by download URL, and CDN files keyed by file name (bytes, or an
 * error status).
 */
function fakePypi(
  releases: Record<string, ReleaseFile[] | number>,
  downloads: Record<string, Buffer>,
  cdn: Record<string, Buffer | number>,
): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = input.toString();
    if (url.startsWith(CDN_BASE)) {
      const served = cdn[decodeURIComponent(url.slice(CDN_BASE.length))];
      if (served === undefined) throw new Error(`no CDN fixture for ${url}`);
      if (typeof served === "number") return new Response("", { status: served });
      return new Response(new Uint8Array(served));
    }
    const meta = /^https:\/\/pypi\.org\/pypi\/([^/]+)\/([^/]+)\/json$/.exec(url);
    if (meta) {
      const release = releases[`${meta[1]}==${meta[2]}`];
      if (release === undefined) throw new Error(`no release fixture for ${url}`);
      if (typeof release === "number") return new Response("", { status: release });
      return Response.json({ urls: release });
    }
    const bytes = downloads[url];
    if (!bytes) throw new Error(`no download fixture for ${url}`);
    return new Response(new Uint8Array(bytes));
  });
}

/** The file names `fetchImpl` requested from Pyodide's CDN, sorted. */
function cdnRequests(fetchImpl: typeof fetch): string[] {
  return vi
    .mocked(fetchImpl)
    .mock.calls.map(([input]) => input.toString())
    .filter((url) => url.startsWith(CDN_BASE))
    .map((url) => decodeURIComponent(url.slice(CDN_BASE.length)))
    .sort();
}

function fileNames(names: readonly string[]): string[] {
  return names.map(bundledFileName).sort();
}

function mixedPypi(overrides: Record<string, ReleaseFile[] | number> = {}): typeof fetch {
  const idna = pureWheel("idna", "3.10", IDNA_SHA);
  const sniffio = pureWheel("sniffio", "1.3.1", SNIFFIO_SHA);
  return fakePypi(
    {
      "idna==3.10": [idna],
      "sniffio==1.3.1": [
        {
          packagetype: "bdist_wheel",
          filename: "sniffio-1.3.1-cp314-cp314-manylinux_2_17_x86_64.whl",
          url: "https://files.pythonhosted.org/packages/sniffio-native.whl",
          digests: { sha256: SNIFFIO_SHA },
        },
        sniffio,
      ],
      ...overrides,
    },
    {
      [idna.url]: IDNA_BYTES,
      [sniffio.url]: SNIFFIO_BYTES,
    },
    pinnedCdn(),
  );
}

/** Published directories are read-only; restore write access so the temp root can be removed. */
async function makeWritable(dir: string): Promise<void> {
  await chmod(dir, 0o755);
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.isDirectory()) await makeWritable(join(dir, d.name));
  }
}

let root: string;
let wheelsRoot: string;
let cacheDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wheel-cache-"));
  wheelsRoot = join(root, "wheels");
  cacheDir = join(root, "cache");
});

afterEach(async () => {
  statHook.before = null;
  rmHook.before = null;
  renameHook.before = null;
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
});

describe("ensureWasmPackages", () => {
  it("downloads the built-ins' closure from Pyodide's CDN and publishes the rest as wheels", async () => {
    const fetchImpl = mixedPypi();
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}
pydantic==2.12.5 --hash=sha256:${OTHER_SHA}
pydantic_core==2.41.5 --hash=sha256:${OTHER_SHA}
`);
    const result = await ensureWasmPackages(
      { fetchImpl, bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrap()).toEqual({
      builtins: ["pydantic", "pydantic-core"],
      wheelDir: join(wheelsRoot, wheelKey(lock.hash)),
    });
    // The built-ins, micropip, and typing-extensions, which both depend on.
    expect(cdnRequests(fetchImpl)).toEqual(fileNames(PYDANTIC_CLOSURE));
    expect((await readdir(cacheDir)).sort()).toEqual(fileNames(PYDANTIC_CLOSURE));
    expect((await readdir(join(wheelsRoot, wheelKey(lock.hash)))).sort()).toEqual([
      ".ready",
      "idna-3.10-py3-none-any.whl",
    ]);
  });

  it("treats a bundled name at another version as a wheel, and downloads micropip to install it", async () => {
    const fetchImpl = fakePypi(
      { "typing-extensions==4.14.0": [pureWheel("typing_extensions", "4.14.0", SNIFFIO_SHA)] },
      { [pureWheel("typing_extensions", "4.14.0", SNIFFIO_SHA).url]: SNIFFIO_BYTES },
      pinnedCdn(),
    );
    const lock = lockfile(`typing-extensions==4.14.0 --hash=sha256:${SNIFFIO_SHA}\n`);
    const result = await ensureWasmPackages(
      { fetchImpl, bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrap()).toEqual({
      builtins: [],
      wheelDir: join(wheelsRoot, wheelKey(lock.hash)),
    });
    expect(cdnRequests(fetchImpl)).toEqual(fileNames(["micropip"]));
  });

  it("downloads nothing when the cache holds every built-in, micropip and their dependencies", async () => {
    const fetchImpl = fakePypi({}, {}, pinnedCdn());
    const packageCacheDir = await cacheWith(cacheDir, PYDANTIC_CLOSURE);
    const result = await ensureWasmPackages(
      { fetchImpl, bundled: BUNDLED },
      { lockfile: PYDANTIC_LOCK, packageCacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("downloads only a built-in's missing transitive dependency", async () => {
    const fetchImpl = fakePypi({}, {}, pinnedCdn());
    const packageCacheDir = await cacheWith(cacheDir, ["pydantic", "pydantic-core", "micropip"]);
    const result = await ensureWasmPackages(
      { fetchImpl, bundled: BUNDLED },
      { lockfile: PYDANTIC_LOCK, packageCacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: null });
    expect(cdnRequests(fetchImpl)).toEqual(fileNames(["typing-extensions"]));
  });

  it("downloads micropip when the cache lacks it", async () => {
    const fetchImpl = fakePypi({}, {}, pinnedCdn());
    const packageCacheDir = await cacheWith(cacheDir, [
      "pydantic",
      "pydantic-core",
      "typing-extensions",
    ]);
    await ensureWasmPackages(
      { fetchImpl, bundled: BUNDLED },
      { lockfile: PYDANTIC_LOCK, packageCacheDir, wheelsRoot },
    );
    expect(cdnRequests(fetchImpl)).toEqual(fileNames(["micropip"]));
  });

  it("deletes a cached file whose sha256 is not the lockfile's, and downloads it again", async () => {
    const packageCacheDir = await cacheWith(cacheDir, PYDANTIC_CLOSURE);
    // A writer killed mid-write leaves a truncated file.
    const coreFile = bundledFileName("pydantic-core");
    const truncated = join(packageCacheDir, coreFile);
    await writeFile(truncated, bundledBytes(coreFile).subarray(0, 5));
    const inner = fakePypi({}, {}, pinnedCdn());
    let presentAtDownload: boolean | null = null;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      presentAtDownload = await exists(truncated);
      return inner(input, init);
    });
    const result = await ensureWasmPackages(
      { fetchImpl, bundled: BUNDLED },
      { lockfile: PYDANTIC_LOCK, packageCacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: null });
    expect(cdnRequests(fetchImpl)).toEqual([coreFile]);
    expect(presentAtDownload).toBe(false);
    expect(sha256(await readFile(truncated))).toBe(sha256(bundledBytes(coreFile)));
  });

  it("writes verified downloads to a private staging directory and moves them into the cache", async () => {
    let stagingMode: number | null = null;
    renameHook.before = async (from) => {
      if (from.startsWith(`${cacheDir}.tmp.`))
        stagingMode = (await stat(dirname(from))).mode & 0o777;
    };
    const result = await ensureWasmPackages(
      { fetchImpl: fakePypi({}, {}, pinnedCdn()), bundled: BUNDLED },
      { lockfile: PYDANTIC_LOCK, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: null });
    expect(stagingMode).toBe(0o700);
    expect((await readdir(cacheDir)).sort()).toEqual(fileNames(PYDANTIC_CLOSURE));
    expect(await readdir(root)).toEqual(["cache"]);
  });

  it("errs builtin_integrity naming a download that fails its sha256, and writes nothing", async () => {
    const coreFile = bundledFileName("pydantic-core");
    const tampered = Buffer.from("tampered bytes");
    const result = await ensureWasmPackages(
      {
        fetchImpl: fakePypi({}, {}, { ...pinnedCdn(), [coreFile]: tampered }),
        bundled: BUNDLED,
      },
      { lockfile: PYDANTIC_LOCK, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "builtin_integrity",
      fileName: coreFile,
      message: expect.stringContaining(
        `${CDN_BASE}${coreFile} hashes to sha256:${sha256(tampered)}`,
      ),
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("errs builtin_integrity and keeps the verified cache when one download fails its sha256", async () => {
    const packageCacheDir = await cacheWith(cacheDir, ["pydantic", "pydantic-core", "micropip"]);
    const typingFile = bundledFileName("typing-extensions");
    const result = await ensureWasmPackages(
      {
        fetchImpl: fakePypi({}, {}, { [typingFile]: Buffer.from("tampered bytes") }),
        bundled: BUNDLED,
      },
      { lockfile: PYDANTIC_LOCK, packageCacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "builtin_integrity",
      fileName: typingFile,
    });
    expect((await readdir(packageCacheDir)).sort()).toEqual(
      fileNames(["pydantic", "pydantic-core", "micropip"]),
    );
    expect(await readdir(root)).toEqual(["cache"]);
  });

  it("errs prefetch_failed naming the URL when the CDN answers an error status, and writes nothing", async () => {
    const pydanticFile = bundledFileName("pydantic");
    const result = await ensureWasmPackages(
      { fetchImpl: fakePypi({}, {}, { ...pinnedCdn(), [pydanticFile]: 404 }), bundled: BUNDLED },
      { lockfile: PYDANTIC_LOCK, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "prefetch_failed",
      message: `http 404 for ${CDN_BASE}${pydanticFile}`,
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("errs prefetch_failed when a download's request fails, and writes nothing", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await ensureWasmPackages(
      { fetchImpl, bundled: BUNDLED },
      { lockfile: MIXED_LOCK, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "prefetch_failed",
      message: expect.stringMatching(new RegExp(`^download ${CDN_BASE}.*: fetch failed$`)),
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("errs prefetch_failed when the caller's signal aborts the download", async () => {
    const result = await ensureWasmPackages(
      { fetchImpl: fakePypi({}, {}, pinnedCdn()), bundled: BUNDLED },
      {
        lockfile: PYDANTIC_LOCK,
        packageCacheDir: cacheDir,
        wheelsRoot,
        signal: AbortSignal.abort(new Error("run cancelled")),
      },
    );
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "prefetch_failed",
      message: expect.stringContaining("run cancelled"),
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("serves two cold-cache resolutions whose downloads overlap", async () => {
    // B's downloads finish only once A has moved its files into the cache, so
    // B renames whole files over A's.
    const aDone = Promise.withResolvers<void>();
    const fetchA = fakePypi({}, {}, pinnedCdn());
    const innerB = fakePypi({}, {}, pinnedCdn());
    const fetchB = vi.fn<typeof fetch>(async (input, init) => {
      const resp = await innerB(input, init);
      await aDone.promise;
      return resp;
    });
    const resolve = (fetchImpl: typeof fetch) =>
      ensureWasmPackages(
        { fetchImpl, bundled: BUNDLED },
        { lockfile: PYDANTIC_LOCK, packageCacheDir: cacheDir, wheelsRoot },
      );
    const a = resolve(fetchA).finally(() => aDone.resolve());
    const b = resolve(fetchB);
    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: null });
    expect(resultB._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: null });
    expect(cdnRequests(fetchB)).toEqual(fileNames(PYDANTIC_CLOSURE));
    const coreFile = bundledFileName("pydantic-core");
    expect(sha256(await readFile(join(cacheDir, coreFile)))).toBe(sha256(bundledBytes(coreFile)));
    expect(await readdir(root)).toEqual(["cache"]);
  });

  it("removes staging directories older than ten minutes beside the cache, and keeps fresh ones", async () => {
    const stale = `${cacheDir}.tmp.dead`;
    const fresh = `${cacheDir}.tmp.live`;
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "half.whl"), "");
    await mkdir(fresh);
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(stale, elevenMinutesAgo, elevenMinutesAgo);
    await ensureWasmPackages(
      { fetchImpl: fakePypi({}, {}, pinnedCdn()), bundled: BUNDLED },
      { lockfile: PYDANTIC_LOCK, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect((await readdir(root)).sort()).toEqual(["cache", "cache.tmp.live"]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "errs builtin_integrity for a cached file that cannot be read",
    async () => {
      const packageCacheDir = await cacheWith(cacheDir, PYDANTIC_CLOSURE);
      const unreadable = join(packageCacheDir, bundledFileName("micropip"));
      await chmod(unreadable, 0o000);
      const fetchImpl = fakePypi({}, {}, pinnedCdn());
      const result = await ensureWasmPackages(
        { fetchImpl, bundled: BUNDLED },
        { lockfile: PYDANTIC_LOCK, packageCacheDir, wheelsRoot },
      );
      expect(result._unsafeUnwrapErr()).toEqual({
        kind: "builtin_integrity",
        fileName: bundledFileName("micropip"),
        message: expect.stringContaining("EACCES"),
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("returns a null wheelDir and touches neither the network nor the wheel root when every package is bundled and cached", async () => {
    const fetchImpl = fakePypi({}, {}, pinnedCdn());
    const packageCacheDir = await cacheWith(cacheDir, PYDANTIC_CLOSURE);
    const result = await ensureWasmPackages(
      { fetchImpl, bundled: BUNDLED },
      { lockfile: PYDANTIC_LOCK, packageCacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(stat(wheelsRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes a directory of its own rather than serve one published under another Pyodide release", async () => {
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`);
    const previous = join(wheelsRoot, wheelKeyAt(lock.hash, "314.0.6"));
    await mkdir(previous, { recursive: true });
    await writeFile(join(previous, ".ready"), "");
    const result = await ensureWasmPackages(
      { fetchImpl: mixedPypi(), bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrap().wheelDir).toBe(join(wheelsRoot, wheelKey(lock.hash)));
    expect((await readdir(join(wheelsRoot, wheelKey(lock.hash)))).sort()).toEqual([
      ".ready",
      "idna-3.10-py3-none-any.whl",
    ]);
    expect(await readdir(previous)).toEqual([".ready"]);
  });

  it("publishes a read-only, link-free directory picked by the lockfile's hashes", async () => {
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}
sniffio==1.3.1 \\
    --hash=sha256:${OTHER_SHA} \\
    --hash=sha256:${SNIFFIO_SHA}
`);
    const result = await ensureWasmPackages(
      { fetchImpl: mixedPypi(), bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    const dir = result._unsafeUnwrap().wheelDir;
    expect(dir).toBe(join(wheelsRoot, wheelKey(lock.hash)));
    if (dir === null) return;
    expect((await stat(dir)).mode & 0o777).toBe(0o555);
    const names = (await readdir(dir)).sort();
    expect(names).toEqual([
      ".ready",
      "idna-3.10-py3-none-any.whl",
      "sniffio-1.3.1-py3-none-any.whl",
    ]);
    for (const name of names) {
      const entry = await lstat(join(dir, name));
      expect(entry.isFile()).toBe(true);
      expect(entry.nlink).toBe(1);
      expect(entry.mode & 0o777).toBe(0o444);
    }
    expect(await readdir(wheelsRoot)).toEqual([wheelKey(lock.hash)]);
  });

  it("serves a published directory without fetching again", async () => {
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`);
    const deps = { fetchImpl: mixedPypi(), bundled: BUNDLED };
    const args = { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot };
    await ensureWasmPackages(deps, args);
    vi.mocked(deps.fetchImpl).mockClear();
    const again = await ensureWasmPackages(deps, args);
    expect(again._unsafeUnwrap().wheelDir).toBe(join(wheelsRoot, wheelKey(lock.hash)));
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("seals a published directory a dying publisher left writable", async () => {
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`);
    const deps = { fetchImpl: mixedPypi(), bundled: BUNDLED };
    const args = { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot };
    await ensureWasmPackages(deps, args);
    const dir = join(wheelsRoot, wheelKey(lock.hash));
    await chmod(dir, 0o755);
    await ensureWasmPackages(deps, args);
    expect((await stat(dir)).mode & 0o777).toBe(0o555);
  });

  it("refuses wheel bytes whose sha256 is not the pinned one, and publishes nothing", async () => {
    const idna = pureWheel("idna", "3.10", IDNA_SHA);
    const fetchImpl = fakePypi(
      { "idna==3.10": [idna] },
      { [idna.url]: Buffer.from("tampered bytes") },
      pinnedCdn(),
    );
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`);
    const result = await ensureWasmPackages(
      { fetchImpl, bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "hash_mismatch", spec: "idna==3.10" });
    expect(await readdir(wheelsRoot)).toEqual([]);
  });

  it("errs wheel_unavailable when no pure wheel carries a pinned hash", async () => {
    const result = await ensureWasmPackages(
      {
        fetchImpl: mixedPypi({ "idna==3.10": [pureWheel("idna", "3.10", OTHER_SHA)] }),
        bundled: BUNDLED,
      },
      {
        lockfile: lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`),
        packageCacheDir: cacheDir,
        wheelsRoot,
      },
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "wheel_unavailable",
      spec: "idna==3.10",
    });
    expect(await readdir(wheelsRoot)).toEqual([]);
  });

  it("errs wheel_unavailable when the only hashed wheel is native", async () => {
    const result = await ensureWasmPackages(
      {
        fetchImpl: mixedPypi({
          "sniffio==1.3.1": [
            {
              packagetype: "bdist_wheel",
              filename: "sniffio-1.3.1-cp314-cp314-manylinux_2_17_x86_64.whl",
              url: "https://files.pythonhosted.org/packages/sniffio-native.whl",
              digests: { sha256: SNIFFIO_SHA },
            },
          ],
        }),
        bundled: BUNDLED,
      },
      {
        lockfile: lockfile(`sniffio==1.3.1 --hash=sha256:${SNIFFIO_SHA}\n`),
        packageCacheDir: cacheDir,
        wheelsRoot,
      },
    );
    expect(result._unsafeUnwrapErr().kind).toBe("wheel_unavailable");
  });

  it("errs wheel_unavailable for a wheel whose filename is not a plain name", async () => {
    const result = await ensureWasmPackages(
      {
        fetchImpl: mixedPypi({
          "idna==3.10": [
            { ...pureWheel("idna", "3.10", IDNA_SHA), filename: "../idna-3.10-py3-none-any.whl" },
          ],
        }),
        bundled: BUNDLED,
      },
      {
        lockfile: lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`),
        packageCacheDir: cacheDir,
        wheelsRoot,
      },
    );
    expect(result._unsafeUnwrapErr().kind).toBe("wheel_unavailable");
    expect((await readdir(root)).sort()).toEqual(["cache", "wheels"]);
  });

  it.each([
    ["a 404 is wheel_unavailable", 404, "wheel_unavailable"],
    ["a 503 is network_failed", 503, "network_failed"],
  ])("%s", async (_label, status, kind) => {
    const result = await ensureWasmPackages(
      {
        fetchImpl: mixedPypi({ "idna==3.10": status }),
        bundled: BUNDLED,
      },
      {
        lockfile: lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`),
        packageCacheDir: cacheDir,
        wheelsRoot,
      },
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind, spec: "idna==3.10" });
  });

  it("errs network_failed when the request itself fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    // micropip is cached, so the only request is PyPI's.
    const packageCacheDir = await cacheWith(cacheDir, ["micropip"]);
    const result = await ensureWasmPackages(
      { fetchImpl, bundled: BUNDLED },
      {
        lockfile: lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`),
        packageCacheDir,
        wheelsRoot,
      },
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "network_failed",
      message: expect.stringContaining("fetch failed"),
    });
  });

  it("succeeds as the loser of the publish race, leaving the winner's copy", async () => {
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`);
    const target = join(wheelsRoot, wheelKey(lock.hash));
    const inner = mixedPypi();
    // Another publisher finishes while this one downloads.
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const resp = await inner(input, init);
      if (input.toString().startsWith("https://files.pythonhosted.org/")) {
        await mkdir(target);
        await writeFile(join(target, "winner.whl"), "winner");
        await writeFile(join(target, ".ready"), "");
      }
      return resp;
    });
    const result = await ensureWasmPackages(
      { fetchImpl, bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrap().wheelDir).toBe(target);
    expect((await readdir(target)).sort()).toEqual([".ready", "winner.whl"]);
    expect(await readdir(wheelsRoot)).toEqual([wheelKey(lock.hash)]);
  });

  it("errs publish_failed when the rename loses to a directory that is not ready", async () => {
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`);
    const target = join(wheelsRoot, wheelKey(lock.hash));
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "partial.whl"), "partial");
    const result = await ensureWasmPackages(
      { fetchImpl: mixedPypi(), bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrapErr().kind).toBe("publish_failed");
    expect(await readdir(wheelsRoot)).toEqual([wheelKey(lock.hash)]);
  });

  it("publishes when a sibling publisher renames a tmp directory away between the sweep's listing and its stat", async () => {
    const sibling = join(wheelsRoot, `${wheelKey(OTHER_SHA)}.tmp.sibling`);
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, ".ready"), "");
    statHook.before = async (path) => {
      if (path === sibling) await rename(sibling, join(wheelsRoot, wheelKey(OTHER_SHA)));
    };
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`);
    const result = await ensureWasmPackages(
      { fetchImpl: mixedPypi(), bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrap().wheelDir).toBe(join(wheelsRoot, wheelKey(lock.hash)));
    expect((await readdir(wheelsRoot)).sort()).toEqual(
      [wheelKey(lock.hash), wheelKey(OTHER_SHA)].sort(),
    );
  });

  it("publishes when the sweep itself fails", async () => {
    const candidate = join(wheelsRoot, `${wheelKey(OTHER_SHA)}.tmp.unreadable`);
    await mkdir(candidate, { recursive: true });
    statHook.before = async (path) => {
      if (path === candidate) {
        throw Object.assign(new Error(`EACCES: permission denied, stat '${path}'`), {
          code: "EACCES",
        });
      }
    };
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`);
    const result = await ensureWasmPackages(
      { fetchImpl: mixedPypi(), bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrap().wheelDir).toBe(join(wheelsRoot, wheelKey(lock.hash)));
  });

  it("removes tmp directories older than ten minutes on the way in", async () => {
    const stale = join(wheelsRoot, `${wheelKey(OTHER_SHA)}.tmp.dead`);
    const fresh = join(wheelsRoot, `${wheelKey(OTHER_SHA)}.tmp.live`);
    await mkdir(stale, { recursive: true });
    await mkdir(fresh);
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(stale, elevenMinutesAgo, elevenMinutesAgo);
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`);
    await ensureWasmPackages(
      { fetchImpl: mixedPypi(), bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect((await readdir(wheelsRoot)).sort()).toEqual(
      [wheelKey(lock.hash), `${wheelKey(OTHER_SHA)}.tmp.live`].sort(),
    );
  });
});

describe("reapWasmWheelDirs", () => {
  const REACHABLE_HASH = "a".repeat(64);
  const REACHABLE = wheelKey(REACHABLE_HASH);
  const UNREACHABLE_OLD = wheelKey("b".repeat(64));
  const UNREACHABLE_FRESH = wheelKey("c".repeat(64));
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

  /** The reap's arguments under the fixture's Pyodide release. */
  function reapArgs(reachableHashes: readonly string[]) {
    return {
      wheelsRoot,
      reachableHashes: new Set(reachableHashes),
      pyodideVersion: PYODIDE_VERSION,
      graceDays: 7,
    };
  }

  /** A published directory: read-only, aged by `mtime`. */
  async function published(name: string, mtime: Date): Promise<void> {
    const dir = join(wheelsRoot, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".ready"), "", { mode: 0o444 });
    await chmod(dir, 0o555);
    await utimes(dir, mtime, mtime);
  }

  // Root removes the sealed entry this test relies on failing to remove.
  it.skipIf(process.getuid?.() === 0)(
    "moves a directory out of its key before removing it, so no reader sees a partial one",
    async () => {
      await published(UNREACHABLE_OLD, eightDaysAgo);
      const dir = join(wheelsRoot, UNREACHABLE_OLD);
      // A sealed entry the removal cannot get through: a removal cut short.
      await chmod(dir, 0o755);
      await mkdir(join(dir, "stuck"));
      await writeFile(join(dir, "stuck", "wheel.whl"), "");
      await chmod(join(dir, "stuck"), 0o555);
      await chmod(dir, 0o555);
      await utimes(dir, eightDaysAgo, eightDaysAgo);

      const result = await reapWasmWheelDirs(reapArgs([]));

      expect(result._unsafeUnwrapErr().kind).toBe("reap_failed");
      const left = await readdir(wheelsRoot);
      expect(left).not.toContain(UNREACHABLE_OLD);
      expect(left).toEqual([expect.stringMatching(new RegExp(`^${UNREACHABLE_OLD}\\.tmp\\.`))]);
    },
  );

  it("skips a directory a concurrent reap moved away, and reaps the rest", async () => {
    const alsoOld = wheelKey("d".repeat(64));
    await published(UNREACHABLE_OLD, eightDaysAgo);
    await published(alsoOld, eightDaysAgo);
    const moved = join(wheelsRoot, UNREACHABLE_OLD);
    // Another reaper moves it out of its key between this reap's listing and
    // its rename; the stale sweep then removes what that reaper left.
    statHook.before = async (path) => {
      if (path === moved) await rename(moved, join(wheelsRoot, `${UNREACHABLE_OLD}.tmp.other`));
    };

    const result = await reapWasmWheelDirs(reapArgs([]));

    expect(result._unsafeUnwrap()).toEqual({ reapedDirs: [alsoOld] });
    expect(await readdir(wheelsRoot)).toEqual([]);
  });

  it("fails the reap when removing a directory it moved out of its key fails", async () => {
    await published(UNREACHABLE_OLD, eightDaysAgo);
    // A code a concurrent move also raises, from the removal of the moved directory.
    rmHook.before = async (path) => {
      if (path.startsWith(join(wheelsRoot, `${UNREACHABLE_OLD}.tmp.`))) {
        throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`), {
          code: "ENOTEMPTY",
        });
      }
    };

    const result = await reapWasmWheelDirs(reapArgs([]));

    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "reap_failed",
      message: expect.stringContaining("ENOTEMPTY"),
    });
    expect(await readdir(wheelsRoot)).toEqual([
      expect.stringMatching(new RegExp(`^${UNREACHABLE_OLD}\\.tmp\\.`)),
    ]);
  });

  it("sweeps a sealed tmp directory a reap left behind", async () => {
    const leftover = `${UNREACHABLE_OLD}.tmp.crashed`;
    await published(leftover, eightDaysAgo);

    const result = await reapWasmWheelDirs(reapArgs([]));

    expect(result._unsafeUnwrap()).toEqual({ reapedDirs: [] });
    expect(await readdir(wheelsRoot)).toEqual([]);
  });

  it("removes unreachable directories past the grace and keeps the rest", async () => {
    await published(REACHABLE, eightDaysAgo);
    await published(UNREACHABLE_OLD, eightDaysAgo);
    await published(UNREACHABLE_FRESH, new Date());
    // Neither is a wheel directory's name, so neither is a candidate.
    for (const name of ["not-a-hash", REACHABLE_HASH]) {
      await mkdir(join(wheelsRoot, name));
      await utimes(join(wheelsRoot, name), eightDaysAgo, eightDaysAgo);
    }

    const result = await reapWasmWheelDirs(reapArgs([REACHABLE_HASH]));

    expect(result._unsafeUnwrap()).toEqual({ reapedDirs: [UNREACHABLE_OLD] });
    expect((await readdir(wheelsRoot)).sort()).toEqual(
      [REACHABLE, UNREACHABLE_FRESH, "not-a-hash", REACHABLE_HASH].sort(),
    );
  });

  it("reaps a reachable hash's directory for another Pyodide release past the grace, and keeps the installed release's", async () => {
    const previous = wheelKeyAt(REACHABLE_HASH, "314.0.6");
    const previousFresh = wheelKeyAt(REACHABLE_HASH, "314.0.5");
    await published(REACHABLE, eightDaysAgo);
    await published(previous, eightDaysAgo);
    await published(previousFresh, new Date());

    const result = await reapWasmWheelDirs(reapArgs([REACHABLE_HASH]));

    expect(result._unsafeUnwrap()).toEqual({ reapedDirs: [previous] });
    expect((await readdir(wheelsRoot)).sort()).toEqual([REACHABLE, previousFresh].sort());
  });

  it("removes stale tmp directories and keeps fresh ones", async () => {
    const stale = join(wheelsRoot, `${REACHABLE}.tmp.dead`);
    const fresh = join(wheelsRoot, `${REACHABLE}.tmp.live`);
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "half.whl"), "", { mode: 0o444 });
    await utimes(stale, eightDaysAgo, eightDaysAgo);
    await mkdir(fresh);

    const result = await reapWasmWheelDirs(reapArgs([]));

    expect(result._unsafeUnwrap()).toEqual({ reapedDirs: [] });
    expect(await readdir(wheelsRoot)).toEqual([`${REACHABLE}.tmp.live`]);
  });

  it("has nothing to reap when the root does not exist", async () => {
    const result = await reapWasmWheelDirs({ ...reapArgs([]), wheelsRoot: join(root, "missing") });
    expect(result._unsafeUnwrap()).toEqual({ reapedDirs: [] });
  });
});
