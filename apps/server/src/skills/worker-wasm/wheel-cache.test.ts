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
import { join } from "node:path";
import { err, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { hashLockfileContents, type LockfileSnapshot } from "../deps.js";
import type { BundledPackage } from "../pyodide-compat.js";
import type { Tier1Prefetcher } from "./tier1.js";
import { ensureTier1Packages, reapTier1WheelDirs, stagedPrefetcher } from "./wheel-cache.js";

/** Runs before each `stat` the module under test makes, to stage a concurrent writer. */
const statHook = vi.hoisted(() => {
  const hook: { before: ((path: string) => Promise<void>) | null } = { before: null };
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
  const pkg = BUNDLED.get(name);
  if (pkg === undefined) throw new Error(`no bundled fixture ${name}`);
  return pkg.fileName;
}

const BUNDLED: ReadonlyMap<string, BundledPackage> = new Map([
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
]);

/** A package cache holding the lockfile-pinned files of `names`. */
async function cacheWith(dir: string, names: readonly string[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (const name of names) {
    const fileName = bundledFileName(name);
    await writeFile(join(dir, fileName), bundledBytes(fileName));
  }
  return dir;
}

/** The prefetch's argument: a staging directory beside `cacheDir`, never the cache itself. */
function stagedBeside(cacheDir: string) {
  return { packageCacheDir: expect.stringMatching(`^${cacheDir.replaceAll(".", "\\.")}\\.tmp\\.`) };
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

/** PyPI by URL: release JSON keyed `name==version`, wheel bytes keyed by download URL. */
function fakePypi(
  releases: Record<string, ReleaseFile[] | number>,
  downloads: Record<string, Buffer>,
): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = input.toString();
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
  );
}

/** A prefetcher that fills the cache with every bundled fixture's pinned file. */
function okPrefetcher() {
  const prefetcher = mock<Tier1Prefetcher>();
  prefetcher.prefetchBuiltins.mockImplementation(async (_names, { packageCacheDir }) => {
    await cacheWith(packageCacheDir, [...BUNDLED.keys()]);
    return ok();
  });
  return prefetcher;
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
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
});

describe("ensureTier1Packages", () => {
  it("prefetches the packages Pyodide bundles at the locked version and publishes the rest as wheels", async () => {
    const prefetcher = okPrefetcher();
    const fetchImpl = mixedPypi();
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}
pydantic==2.12.5 --hash=sha256:${OTHER_SHA}
pydantic_core==2.41.5 --hash=sha256:${OTHER_SHA}
`);
    const result = await ensureTier1Packages(
      { prefetcher, fetchImpl, bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrap()).toEqual({
      builtins: ["pydantic", "pydantic-core"],
      wheelDir: join(wheelsRoot, lock.hash),
    });
    expect(prefetcher.prefetchBuiltins).toHaveBeenCalledWith(
      ["pydantic", "pydantic-core"],
      stagedBeside(cacheDir),
    );
    expect((await readdir(join(wheelsRoot, lock.hash))).sort()).toEqual([
      ".ready",
      "idna-3.10-py3-none-any.whl",
    ]);
  });

  it("treats a bundled name at another version as a wheel, and prefetches micropip to install it", async () => {
    const fetchImpl = fakePypi(
      { "typing-extensions==4.14.0": [pureWheel("typing_extensions", "4.14.0", SNIFFIO_SHA)] },
      { [pureWheel("typing_extensions", "4.14.0", SNIFFIO_SHA).url]: SNIFFIO_BYTES },
    );
    const prefetcher = okPrefetcher();
    const lock = lockfile(`typing-extensions==4.14.0 --hash=sha256:${SNIFFIO_SHA}\n`);
    const result = await ensureTier1Packages(
      { prefetcher, fetchImpl, bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrap()).toEqual({
      builtins: [],
      wheelDir: join(wheelsRoot, lock.hash),
    });
    expect(prefetcher.prefetchBuiltins).toHaveBeenCalledWith([], stagedBeside(cacheDir));
  });

  it("skips the prefetch when the cache holds every built-in, micropip and their dependencies", async () => {
    const prefetcher = okPrefetcher();
    const packageCacheDir = await cacheWith(cacheDir, [
      "pydantic",
      "pydantic-core",
      "typing-extensions",
      "micropip",
    ]);
    const result = await ensureTier1Packages(
      { prefetcher, fetchImpl: fakePypi({}, {}), bundled: BUNDLED },
      {
        lockfile: lockfile(`pydantic==2.12.5 --hash=sha256:${OTHER_SHA}\n`),
        packageCacheDir,
        wheelsRoot,
      },
    );
    expect(result._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: null });
    expect(prefetcher.prefetchBuiltins).not.toHaveBeenCalled();
  });

  it("prefetches when the cache lacks a built-in's transitive dependency", async () => {
    const prefetcher = okPrefetcher();
    const packageCacheDir = await cacheWith(cacheDir, ["pydantic", "pydantic-core", "micropip"]);
    const result = await ensureTier1Packages(
      { prefetcher, fetchImpl: fakePypi({}, {}), bundled: BUNDLED },
      {
        lockfile: lockfile(`pydantic==2.12.5 --hash=sha256:${OTHER_SHA}\n`),
        packageCacheDir,
        wheelsRoot,
      },
    );
    expect(result._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: null });
    expect(prefetcher.prefetchBuiltins).toHaveBeenCalledWith(
      ["pydantic"],
      stagedBeside(packageCacheDir),
    );
  });

  it("deletes a cached file whose sha256 is not the lockfile's, and prefetches it again", async () => {
    const prefetcher = okPrefetcher();
    const packageCacheDir = await cacheWith(cacheDir, [
      "pydantic",
      "pydantic-core",
      "typing-extensions",
      "micropip",
    ]);
    // A prefetch child killed mid-write leaves a truncated file.
    const truncated = join(packageCacheDir, bundledFileName("pydantic-core"));
    await writeFile(truncated, bundledBytes(bundledFileName("pydantic-core")).subarray(0, 5));
    const fill = prefetcher.prefetchBuiltins.getMockImplementation();
    let presentAtPrefetch: boolean | null = null;
    prefetcher.prefetchBuiltins.mockImplementation(async (names, opts) => {
      presentAtPrefetch = await exists(truncated);
      return fill ? fill(names, opts) : ok();
    });
    const result = await ensureTier1Packages(
      { prefetcher, fetchImpl: fakePypi({}, {}), bundled: BUNDLED },
      {
        lockfile: lockfile(`pydantic==2.12.5 --hash=sha256:${OTHER_SHA}\n`),
        packageCacheDir,
        wheelsRoot,
      },
    );
    expect(result._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: null });
    expect(prefetcher.prefetchBuiltins).toHaveBeenCalledWith(
      ["pydantic"],
      stagedBeside(packageCacheDir),
    );
    expect(presentAtPrefetch).toBe(false);
  });

  it("prefetches into a private staging directory and moves the verified files into the cache", async () => {
    const prefetcher = mock<Tier1Prefetcher>();
    let stagingMode: number | null = null;
    prefetcher.prefetchBuiltins.mockImplementation(async (_names, { packageCacheDir }) => {
      stagingMode = (await stat(packageCacheDir)).mode & 0o777;
      await cacheWith(packageCacheDir, [...BUNDLED.keys()]);
      return ok();
    });
    const result = await ensureTier1Packages(
      { prefetcher, fetchImpl: fakePypi({}, {}), bundled: BUNDLED },
      {
        lockfile: lockfile(`pydantic==2.12.5 --hash=sha256:${OTHER_SHA}\n`),
        packageCacheDir: cacheDir,
        wheelsRoot,
      },
    );
    expect(result._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: null });
    expect(prefetcher.prefetchBuiltins).toHaveBeenCalledWith(["pydantic"], stagedBeside(cacheDir));
    expect(stagingMode).toBe(0o700);
    expect((await readdir(cacheDir)).sort()).toEqual(
      ["pydantic", "pydantic-core", "typing-extensions", "micropip"].map(bundledFileName).sort(),
    );
    expect(await readdir(root)).toEqual(["cache"]);
  });

  it("errs builtin_integrity naming a staged file that fails its sha256, and moves nothing into the cache", async () => {
    const prefetcher = mock<Tier1Prefetcher>();
    prefetcher.prefetchBuiltins.mockImplementation(async (_names, { packageCacheDir }) => {
      await cacheWith(packageCacheDir, [...BUNDLED.keys()]);
      // What a tampered CDN response leaves behind.
      await writeFile(join(packageCacheDir, bundledFileName("pydantic-core")), "tampered bytes");
      return ok();
    });
    const result = await ensureTier1Packages(
      { prefetcher, fetchImpl: fakePypi({}, {}), bundled: BUNDLED },
      {
        lockfile: lockfile(`pydantic==2.12.5 --hash=sha256:${OTHER_SHA}\n`),
        packageCacheDir: cacheDir,
        wheelsRoot,
      },
    );
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "builtin_integrity",
      fileName: bundledFileName("pydantic-core"),
      message: expect.stringContaining(`sha256:${sha256(Buffer.from("tampered bytes"))}`),
    });
    expect(await readdir(cacheDir)).toEqual([]);
    expect(await readdir(root)).toEqual(["cache"]);
  });

  it("serves two cold-cache resolutions whose prefetches overlap", async () => {
    // B's prefetch is mid-write after A's has written everything and before A
    // checks what it fetched.
    const coreFile = bundledFileName("pydantic-core");
    const aWrote = Promise.withResolvers<void>();
    const bWrotePartial = Promise.withResolvers<void>();
    const aDone = Promise.withResolvers<void>();
    // Each resolution's signal tells the stub whose prefetch it is serving.
    const signalA = new AbortController().signal;
    const signalB = new AbortController().signal;
    const prefetcher = mock<Tier1Prefetcher>();
    prefetcher.prefetchBuiltins.mockImplementation(async (_names, { packageCacheDir, signal }) => {
      if (signal === signalA) {
        await cacheWith(packageCacheDir, [...BUNDLED.keys()]);
        aWrote.resolve();
        await bWrotePartial.promise;
        return ok();
      }
      await aWrote.promise;
      await mkdir(packageCacheDir, { recursive: true });
      await writeFile(join(packageCacheDir, coreFile), bundledBytes(coreFile).subarray(0, 5));
      bWrotePartial.resolve();
      await aDone.promise;
      await cacheWith(packageCacheDir, [...BUNDLED.keys()]);
      return ok();
    });
    const resolve = (signal: AbortSignal) =>
      ensureTier1Packages(
        { prefetcher, fetchImpl: fakePypi({}, {}), bundled: BUNDLED },
        {
          lockfile: lockfile(`pydantic==2.12.5 --hash=sha256:${OTHER_SHA}\n`),
          packageCacheDir: cacheDir,
          wheelsRoot,
          signal,
        },
      );
    const a = resolve(signalA).finally(() => aDone.resolve());
    const b = resolve(signalB);
    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: null });
    expect(resultB._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: null });
    expect(prefetcher.prefetchBuiltins).toHaveBeenCalledTimes(2);
    expect(sha256(await readFile(join(cacheDir, coreFile)))).toBe(sha256(bundledBytes(coreFile)));
  });

  it("removes staging directories older than ten minutes beside the cache, and keeps fresh ones", async () => {
    const stale = `${cacheDir}.tmp.dead`;
    const fresh = `${cacheDir}.tmp.live`;
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "half.whl"), "");
    await mkdir(fresh);
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(stale, elevenMinutesAgo, elevenMinutesAgo);
    await ensureTier1Packages(
      { prefetcher: okPrefetcher(), fetchImpl: fakePypi({}, {}), bundled: BUNDLED },
      {
        lockfile: lockfile(`pydantic==2.12.5 --hash=sha256:${OTHER_SHA}\n`),
        packageCacheDir: cacheDir,
        wheelsRoot,
      },
    );
    expect((await readdir(root)).sort()).toEqual(["cache", "cache.tmp.live"]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "errs builtin_integrity for a cached file that cannot be read",
    async () => {
      const packageCacheDir = await cacheWith(cacheDir, [...BUNDLED.keys()]);
      const unreadable = join(packageCacheDir, bundledFileName("micropip"));
      await chmod(unreadable, 0o000);
      const prefetcher = okPrefetcher();
      const result = await ensureTier1Packages(
        { prefetcher, fetchImpl: fakePypi({}, {}), bundled: BUNDLED },
        {
          lockfile: lockfile(`pydantic==2.12.5 --hash=sha256:${OTHER_SHA}\n`),
          packageCacheDir,
          wheelsRoot,
        },
      );
      expect(result._unsafeUnwrapErr()).toEqual({
        kind: "builtin_integrity",
        fileName: bundledFileName("micropip"),
        message: expect.stringContaining("EACCES"),
      });
      expect(prefetcher.prefetchBuiltins).not.toHaveBeenCalled();
    },
  );

  it("errs prefetch_failed naming the file when the prefetch leaves it absent", async () => {
    const prefetcher = mock<Tier1Prefetcher>();
    prefetcher.prefetchBuiltins.mockResolvedValue(ok());
    const result = await ensureTier1Packages(
      { prefetcher, fetchImpl: fakePypi({}, {}), bundled: BUNDLED },
      {
        lockfile: lockfile(`pydantic==2.12.5 --hash=sha256:${OTHER_SHA}\n`),
        packageCacheDir: cacheDir,
        wheelsRoot,
      },
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "prefetch_failed",
      message: expect.stringContaining(bundledFileName("pydantic")),
    });
  });

  it("prefetches when the cache lacks micropip", async () => {
    const prefetcher = okPrefetcher();
    const packageCacheDir = await cacheWith(cacheDir, [
      "pydantic",
      "pydantic-core",
      "typing-extensions",
    ]);
    await ensureTier1Packages(
      { prefetcher, fetchImpl: fakePypi({}, {}), bundled: BUNDLED },
      {
        lockfile: lockfile(`pydantic==2.12.5 --hash=sha256:${OTHER_SHA}\n`),
        packageCacheDir,
        wheelsRoot,
      },
    );
    expect(prefetcher.prefetchBuiltins).toHaveBeenCalledWith(
      ["pydantic"],
      stagedBeside(packageCacheDir),
    );
  });

  it("returns a null wheelDir and touches neither PyPI nor the disk when every package is bundled", async () => {
    const fetchImpl = fakePypi({}, {});
    const result = await ensureTier1Packages(
      { prefetcher: okPrefetcher(), fetchImpl, bundled: BUNDLED },
      {
        lockfile: lockfile(`pydantic==2.12.5 --hash=sha256:${OTHER_SHA}\n`),
        packageCacheDir: cacheDir,
        wheelsRoot,
      },
    );
    expect(result._unsafeUnwrap()).toEqual({ builtins: ["pydantic"], wheelDir: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(stat(wheelsRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("errs prefetch_failed when the package cache cannot be filled", async () => {
    const prefetcher = mock<Tier1Prefetcher>();
    prefetcher.prefetchBuiltins.mockResolvedValue(err("cdn down"));
    const result = await ensureTier1Packages(
      { prefetcher, fetchImpl: mixedPypi(), bundled: BUNDLED },
      { lockfile: MIXED_LOCK, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrapErr()).toEqual({ kind: "prefetch_failed", message: "cdn down" });
  });

  it("publishes a read-only, link-free directory picked by the lockfile's hashes", async () => {
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}
sniffio==1.3.1 \\
    --hash=sha256:${OTHER_SHA} \\
    --hash=sha256:${SNIFFIO_SHA}
`);
    const result = await ensureTier1Packages(
      { prefetcher: okPrefetcher(), fetchImpl: mixedPypi(), bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    const dir = result._unsafeUnwrap().wheelDir;
    expect(dir).toBe(join(wheelsRoot, lock.hash));
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
    expect(await readdir(wheelsRoot)).toEqual([lock.hash]);
  });

  it("serves a published directory without fetching again", async () => {
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`);
    const deps = { prefetcher: okPrefetcher(), fetchImpl: mixedPypi(), bundled: BUNDLED };
    const args = { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot };
    await ensureTier1Packages(deps, args);
    vi.mocked(deps.fetchImpl).mockClear();
    const again = await ensureTier1Packages(deps, args);
    expect(again._unsafeUnwrap().wheelDir).toBe(join(wheelsRoot, lock.hash));
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("seals a published directory a dying publisher left writable", async () => {
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`);
    const deps = { prefetcher: okPrefetcher(), fetchImpl: mixedPypi(), bundled: BUNDLED };
    const args = { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot };
    await ensureTier1Packages(deps, args);
    const dir = join(wheelsRoot, lock.hash);
    await chmod(dir, 0o755);
    await ensureTier1Packages(deps, args);
    expect((await stat(dir)).mode & 0o777).toBe(0o555);
  });

  it("refuses wheel bytes whose sha256 is not the pinned one, and publishes nothing", async () => {
    const idna = pureWheel("idna", "3.10", IDNA_SHA);
    const fetchImpl = fakePypi(
      { "idna==3.10": [idna] },
      { [idna.url]: Buffer.from("tampered bytes") },
    );
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`);
    const result = await ensureTier1Packages(
      { prefetcher: okPrefetcher(), fetchImpl, bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "hash_mismatch", spec: "idna==3.10" });
    expect(await readdir(wheelsRoot)).toEqual([]);
  });

  it("errs wheel_unavailable when no pure wheel carries a pinned hash", async () => {
    const result = await ensureTier1Packages(
      {
        prefetcher: okPrefetcher(),
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
    const result = await ensureTier1Packages(
      {
        prefetcher: okPrefetcher(),
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
    const result = await ensureTier1Packages(
      {
        prefetcher: okPrefetcher(),
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
    const result = await ensureTier1Packages(
      {
        prefetcher: okPrefetcher(),
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
    const result = await ensureTier1Packages(
      { prefetcher: okPrefetcher(), fetchImpl, bundled: BUNDLED },
      {
        lockfile: lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`),
        packageCacheDir: cacheDir,
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
    const target = join(wheelsRoot, lock.hash);
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
    const result = await ensureTier1Packages(
      { prefetcher: okPrefetcher(), fetchImpl, bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrap().wheelDir).toBe(target);
    expect((await readdir(target)).sort()).toEqual([".ready", "winner.whl"]);
    expect(await readdir(wheelsRoot)).toEqual([lock.hash]);
  });

  it("errs publish_failed when the rename loses to a directory that is not ready", async () => {
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`);
    const target = join(wheelsRoot, lock.hash);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "partial.whl"), "partial");
    const result = await ensureTier1Packages(
      { prefetcher: okPrefetcher(), fetchImpl: mixedPypi(), bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrapErr().kind).toBe("publish_failed");
    expect(await readdir(wheelsRoot)).toEqual([lock.hash]);
  });

  it("publishes when a sibling publisher renames a tmp directory away between the sweep's listing and its stat", async () => {
    const sibling = join(wheelsRoot, `${OTHER_SHA}.tmp.sibling`);
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, ".ready"), "");
    statHook.before = async (path) => {
      if (path === sibling) await rename(sibling, join(wheelsRoot, OTHER_SHA));
    };
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`);
    const result = await ensureTier1Packages(
      { prefetcher: okPrefetcher(), fetchImpl: mixedPypi(), bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrap().wheelDir).toBe(join(wheelsRoot, lock.hash));
    expect((await readdir(wheelsRoot)).sort()).toEqual([lock.hash, OTHER_SHA].sort());
  });

  it("publishes when the sweep itself fails", async () => {
    const candidate = join(wheelsRoot, `${OTHER_SHA}.tmp.unreadable`);
    await mkdir(candidate, { recursive: true });
    statHook.before = async (path) => {
      if (path === candidate) {
        throw Object.assign(new Error(`EACCES: permission denied, stat '${path}'`), {
          code: "EACCES",
        });
      }
    };
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`);
    const result = await ensureTier1Packages(
      { prefetcher: okPrefetcher(), fetchImpl: mixedPypi(), bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect(result._unsafeUnwrap().wheelDir).toBe(join(wheelsRoot, lock.hash));
  });

  it("removes tmp directories older than ten minutes on the way in", async () => {
    const stale = join(wheelsRoot, `${OTHER_SHA}.tmp.dead`);
    const fresh = join(wheelsRoot, `${OTHER_SHA}.tmp.live`);
    await mkdir(stale, { recursive: true });
    await mkdir(fresh);
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(stale, elevenMinutesAgo, elevenMinutesAgo);
    const lock = lockfile(`idna==3.10 --hash=sha256:${IDNA_SHA}\n`);
    await ensureTier1Packages(
      { prefetcher: okPrefetcher(), fetchImpl: mixedPypi(), bundled: BUNDLED },
      { lockfile: lock, packageCacheDir: cacheDir, wheelsRoot },
    );
    expect((await readdir(wheelsRoot)).sort()).toEqual([lock.hash, `${OTHER_SHA}.tmp.live`].sort());
  });
});

describe("reapTier1WheelDirs", () => {
  const REACHABLE = "a".repeat(64);
  const UNREACHABLE_OLD = "b".repeat(64);
  const UNREACHABLE_FRESH = "c".repeat(64);
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

  /** A published directory: read-only, aged by `mtime`. */
  async function published(name: string, mtime: Date): Promise<void> {
    const dir = join(wheelsRoot, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".ready"), "", { mode: 0o444 });
    await chmod(dir, 0o555);
    await utimes(dir, mtime, mtime);
  }

  it("moves a directory out of its hash before removing it, so no reader sees a partial one", async () => {
    await published(UNREACHABLE_OLD, eightDaysAgo);
    const dir = join(wheelsRoot, UNREACHABLE_OLD);
    // A sealed entry the removal cannot get through: a removal cut short.
    await chmod(dir, 0o755);
    await mkdir(join(dir, "stuck"));
    await writeFile(join(dir, "stuck", "wheel.whl"), "");
    await chmod(join(dir, "stuck"), 0o555);
    await chmod(dir, 0o555);
    await utimes(dir, eightDaysAgo, eightDaysAgo);

    const result = await reapTier1WheelDirs({
      wheelsRoot,
      reachableHashes: new Set(),
      graceDays: 7,
    });

    expect(result._unsafeUnwrapErr().kind).toBe("reap_failed");
    const left = await readdir(wheelsRoot);
    expect(left).not.toContain(UNREACHABLE_OLD);
    expect(left).toEqual([expect.stringMatching(new RegExp(`^${UNREACHABLE_OLD}\\.tmp\\.`))]);
  });

  it("sweeps a sealed tmp directory a reap left behind", async () => {
    const leftover = `${UNREACHABLE_OLD}.tmp.crashed`;
    await published(leftover, eightDaysAgo);

    const result = await reapTier1WheelDirs({
      wheelsRoot,
      reachableHashes: new Set(),
      graceDays: 7,
    });

    expect(result._unsafeUnwrap()).toEqual({ reapedHashes: [] });
    expect(await readdir(wheelsRoot)).toEqual([]);
  });

  it("removes unreachable directories past the grace and keeps the rest", async () => {
    await published(REACHABLE, eightDaysAgo);
    await published(UNREACHABLE_OLD, eightDaysAgo);
    await published(UNREACHABLE_FRESH, new Date());
    await mkdir(join(wheelsRoot, "not-a-hash"));
    await utimes(join(wheelsRoot, "not-a-hash"), eightDaysAgo, eightDaysAgo);

    const result = await reapTier1WheelDirs({
      wheelsRoot,
      reachableHashes: new Set([REACHABLE]),
      graceDays: 7,
    });

    expect(result._unsafeUnwrap()).toEqual({ reapedHashes: [UNREACHABLE_OLD] });
    expect((await readdir(wheelsRoot)).sort()).toEqual(
      [REACHABLE, UNREACHABLE_FRESH, "not-a-hash"].sort(),
    );
  });

  it("removes stale tmp directories and keeps fresh ones", async () => {
    const stale = join(wheelsRoot, `${REACHABLE}.tmp.dead`);
    const fresh = join(wheelsRoot, `${REACHABLE}.tmp.live`);
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "half.whl"), "", { mode: 0o444 });
    await utimes(stale, eightDaysAgo, eightDaysAgo);
    await mkdir(fresh);

    const result = await reapTier1WheelDirs({
      wheelsRoot,
      reachableHashes: new Set(),
      graceDays: 7,
    });

    expect(result._unsafeUnwrap()).toEqual({ reapedHashes: [] });
    expect(await readdir(wheelsRoot)).toEqual([`${REACHABLE}.tmp.live`]);
  });

  it("has nothing to reap when the root does not exist", async () => {
    const result = await reapTier1WheelDirs({
      wheelsRoot: join(root, "missing"),
      reachableHashes: new Set(),
      graceDays: 7,
    });
    expect(result._unsafeUnwrap()).toEqual({ reapedHashes: [] });
  });
});

describe("stagedPrefetcher", () => {
  it("fails the prefetch with the lockfile's message when Pyodide's lockfile cannot be read", async () => {
    const raw = mock<Tier1Prefetcher>();
    const staged = stagedPrefetcher({
      prefetcher: raw,
      loadBundled: async () => err({ message: "pyodide-lock.json: ENOENT" }),
    });

    const result = await staged.prefetchBuiltins(["pydantic"], { packageCacheDir: root });

    expect(result._unsafeUnwrapErr()).toBe("pyodide-lock.json: ENOENT");
    expect(raw.prefetchBuiltins).not.toHaveBeenCalled();
  });

  it("delegates the probe untouched", async () => {
    const raw = mock<Tier1Prefetcher>();
    raw.probeBuiltins.mockResolvedValue(ok());
    const staged = stagedPrefetcher({ prefetcher: raw, loadBundled: async () => ok(BUNDLED) });

    await staged.probeBuiltins(["pydantic"], { packageCacheDir: root });

    expect(raw.probeBuiltins).toHaveBeenCalledWith(["pydantic"], { packageCacheDir: root });
  });
});
