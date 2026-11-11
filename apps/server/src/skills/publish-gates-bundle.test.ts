import {
  chmod,
  copyFile,
  cp,
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
import { pathToFileURL } from "node:url";
import { err, ok, type Result } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { GATES_BUNDLE_FILES, gatesBundleDigest } from "./gates-files.js";
import { publishGatesBundle, releaseGatesBundle } from "./publish-gates-bundle.js";

// The filesystem as it is, with `rename`, `copyFile`, `rm` and `stat` spied
// on, so a test can stand in a concurrent publish, a failing copy, rename or
// `stat` at one call, or see when the cleanup runs.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    copyFile: vi.fn(actual.copyFile),
    rm: vi.fn(actual.rm),
    stat: vi.fn(actual.stat),
  };
});

let root: string;
/** A bundle's three files, as a release ships them. */
let source: string;
/** `$SANDBOX_GATES_DIR`. */
let gatesRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogmo-publish-gates-"));
  source = join(root, "source");
  gatesRoot = join(root, "gates");
  await mkdir(source);
  await mkdir(gatesRoot);
  await Promise.all(
    GATES_BUNDLE_FILES.map((file) => writeFile(join(source, file), `the bytes of ${file}`)),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A `boundSources` that answers `sources`, and records each call. */
function bound(sources: Result<ReadonlySet<string>, string>) {
  return vi.fn(async () => sources);
}

const NOTHING_BOUND = ok<ReadonlySet<string>, string>(new Set());

/** A directory under `$SANDBOX_GATES_DIR` named as another release's digest. */
async function otherRelease(digestChar: string): Promise<string> {
  const dir = join(gatesRoot, digestChar.repeat(64));
  await mkdir(dir);
  await writeFile(join(dir, "gates.mjs"), "another release's");
  return dir;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Set `path`'s mtime `ms` in the past. */
async function age(path: string, ms: number): Promise<void> {
  const then = new Date(Date.now() - ms);
  await utimes(path, then, then);
}

/** The entries of `$SANDBOX_GATES_DIR` a publish writes before its rename. */
async function temporaries(): Promise<string[]> {
  return (await readdir(gatesRoot)).filter((name) => name.startsWith(".publishing-"));
}

/** An error with `code`, as Node's filesystem raises it. */
function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: stood in`), { code });
}

describe("releaseGatesBundle", () => {
  /** A built server's layout: a chunk at `dist/`'s root, the bundle beside it. */
  async function builtServer(): Promise<{ moduleUrl: string; bundle: string }> {
    const dist = join(root, "dist");
    const bundle = join(dist, "skills-gates");
    await mkdir(bundle, { recursive: true });
    await Promise.all(
      GATES_BUNDLE_FILES.map((file) => writeFile(join(bundle, file), `built ${file}`)),
    );
    return { moduleUrl: pathToFileURL(join(dist, "chunk-abc.js")).href, bundle };
  }

  it("is skills-gates/ beside the built server's module", async () => {
    const { moduleUrl, bundle } = await builtServer();

    expect(await releaseGatesBundle(moduleUrl)).toBe(bundle);
  });

  it("fails naming each file the built server's bundle lacks", async () => {
    const { moduleUrl, bundle } = await builtServer();
    await rm(join(bundle, "tree-sitter-python.wasm"));
    await rm(join(bundle, "gates.mjs"));

    await expect(releaseGatesBundle(moduleUrl)).rejects.toThrow(
      `the release's gates bundle lacks ${join(bundle, "gates.mjs")}, ${join(bundle, "tree-sitter-python.wasm")}`,
    );
  });

  it("fails naming an entry of the bundle that is not a file", async () => {
    const { moduleUrl, bundle } = await builtServer();
    await rm(join(bundle, "web-tree-sitter.wasm"));
    await mkdir(join(bundle, "web-tree-sitter.wasm"));

    await expect(releaseGatesBundle(moduleUrl)).rejects.toThrow(
      `the release's gates bundle lacks ${join(bundle, "web-tree-sitter.wasm")}`,
    );
  });
});

describe("publishGatesBundle", () => {
  it("publishes the bundle at <root>/<digest>, readable by any user", async () => {
    const digest = await gatesBundleDigest(source);

    const published = await publishGatesBundle(
      { boundSources: bound(NOTHING_BOUND) },
      { sourceDir: source, root: gatesRoot },
    );

    expect(published).toEqual({ hostDir: join(gatesRoot, digest), digest });
    expect(await gatesBundleDigest(published.hostDir)).toBe(digest);
    expect((await readdir(published.hostDir)).sort()).toEqual([...GATES_BUNDLE_FILES].sort());
    expect((await stat(published.hostDir)).mode & 0o777).toBe(0o755);
    const modes = await Promise.all(
      GATES_BUNDLE_FILES.map(async (f) => (await stat(join(published.hostDir, f))).mode & 0o777),
    );
    expect(modes).toEqual(GATES_BUNDLE_FILES.map(() => 0o644));
  });

  it("leaves nothing but the digest's directory", async () => {
    const published = await publishGatesBundle(
      { boundSources: bound(NOTHING_BOUND) },
      { sourceDir: source, root: gatesRoot },
    );

    expect(await readdir(gatesRoot)).toEqual([published.digest]);
  });

  it("keeps a directory an earlier boot of the release published", async () => {
    const first = await publishGatesBundle(
      { boundSources: bound(NOTHING_BOUND) },
      { sourceDir: source, root: gatesRoot },
    );
    const marker = (await stat(join(first.hostDir, "gates.mjs"))).ino;

    const again = await publishGatesBundle(
      { boundSources: bound(NOTHING_BOUND) },
      { sourceDir: source, root: gatesRoot },
    );

    expect(again).toEqual(first);
    expect((await stat(join(again.hostDir, "gates.mjs"))).ino).toBe(marker);
  });

  it("refreshes the mtime of the directory it reuses, which another release's boot reads as its age", async () => {
    const first = await publishGatesBundle(
      { boundSources: bound(NOTHING_BOUND) },
      { sourceDir: source, root: gatesRoot },
    );
    await age(first.hostDir, 2 * DAY_MS);

    await publishGatesBundle(
      { boundSources: bound(NOTHING_BOUND) },
      { sourceDir: source, root: gatesRoot },
    );

    expect(Date.now() - (await stat(first.hostDir)).mtimeMs).toBeLessThan(MINUTE_MS);
  });

  it("opens the directory it reuses to every user again", async () => {
    const first = await publishGatesBundle(
      { boundSources: bound(NOTHING_BOUND) },
      { sourceDir: source, root: gatesRoot },
    );
    await Promise.all(GATES_BUNDLE_FILES.map((f) => chmod(join(first.hostDir, f), 0o600)));
    await chmod(first.hostDir, 0o700);

    await publishGatesBundle(
      { boundSources: bound(NOTHING_BOUND) },
      { sourceDir: source, root: gatesRoot },
    );

    expect((await stat(first.hostDir)).mode & 0o777).toBe(0o755);
    const modes = await Promise.all(
      GATES_BUNDLE_FILES.map(async (f) => (await stat(join(first.hostDir, f))).mode & 0o777),
    );
    expect(modes).toEqual(GATES_BUNDLE_FILES.map(() => 0o644));
  });

  it("takes a directory a concurrent publish renamed into place first, when its bytes are the bundle's", async () => {
    const digest = await gatesBundleDigest(source);
    const hostDir = join(gatesRoot, digest);
    vi.mocked(rename).mockImplementationOnce(async () => {
      await cp(source, hostDir, { recursive: true });
      throw fsError("ENOTEMPTY");
    });

    const published = await publishGatesBundle(
      { boundSources: bound(NOTHING_BOUND) },
      { sourceDir: source, root: gatesRoot },
    );

    expect(published).toEqual({ hostDir, digest });
    expect(await temporaries()).toEqual([]);
  });

  it("fails naming a directory a concurrent publish renamed into place first with other bytes", async () => {
    const digest = await gatesBundleDigest(source);
    const hostDir = join(gatesRoot, digest);
    vi.mocked(rename).mockImplementationOnce(async () => {
      await mkdir(hostDir);
      await Promise.all(GATES_BUNDLE_FILES.map((f) => writeFile(join(hostDir, f), "planted")));
      throw fsError("EEXIST");
    });

    await expect(
      publishGatesBundle(
        { boundSources: bound(NOTHING_BOUND) },
        { sourceDir: source, root: gatesRoot },
      ),
    ).rejects.toThrow(`${hostDir} does not hold the gates bundle its name digests`);
    expect(await temporaries()).toEqual([]);
  });

  it("removes its temporary directory once every copy has settled, and rethrows the copy's error", async () => {
    const realCopyFile = vi.mocked(copyFile).getMockImplementation();
    if (realCopyFile === undefined) throw new Error("copyFile is not spied on");
    let releaseSecond = (): void => {};
    const secondHeld = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    vi.mocked(copyFile)
      .mockRejectedValueOnce(fsError("EIO"))
      .mockImplementationOnce(async (from, to, mode) => {
        await secondHeld;
        await realCopyFile(from, to, mode);
      });

    const publishing = publishGatesBundle(
      { boundSources: bound(NOTHING_BOUND) },
      { sourceDir: source, root: gatesRoot },
    );
    publishing.catch(() => undefined);
    // Every copy has started, the first has failed, and the second is still writing.
    await vi.waitFor(() => expect(copyFile).toHaveBeenCalledTimes(GATES_BUNDLE_FILES.length));
    await new Promise((resolve) => setImmediate(resolve));
    expect(rm).not.toHaveBeenCalled();
    releaseSecond();

    await expect(publishing).rejects.toThrow("EIO: stood in");
    expect(await readdir(gatesRoot)).toEqual([]);
  });

  it("fails naming a digest's directory that holds other bytes", async () => {
    const digest = await gatesBundleDigest(source);
    const planted = join(gatesRoot, digest);
    await mkdir(planted);
    await Promise.all(GATES_BUNDLE_FILES.map((file) => writeFile(join(planted, file), "planted")));

    await expect(
      publishGatesBundle(
        { boundSources: bound(NOTHING_BOUND) },
        { sourceDir: source, root: gatesRoot },
      ),
    ).rejects.toThrow(`${planted} does not hold the gates bundle its name digests`);
  });

  it("fails naming a digest's directory with a file missing, as one the daemon created for a bind", async () => {
    const digest = await gatesBundleDigest(source);
    const empty = join(gatesRoot, digest);
    await mkdir(empty);

    await expect(
      publishGatesBundle(
        { boundSources: bound(NOTHING_BOUND) },
        { sourceDir: source, root: gatesRoot },
      ),
    ).rejects.toThrow(
      new RegExp(`^${empty} does not hold the gates bundle its name digests \\(ENOENT`),
    );
  });

  it("fails naming a file the source lacks", async () => {
    await rm(join(source, "web-tree-sitter.wasm"));

    await expect(
      publishGatesBundle(
        { boundSources: bound(NOTHING_BOUND) },
        { sourceDir: source, root: gatesRoot },
      ),
    ).rejects.toThrow(join(source, "web-tree-sitter.wasm"));
  });

  it("removes another release's directory no container binds once a day has passed since its boot", async () => {
    const other = await otherRelease("a");
    await age(other, DAY_MS + MINUTE_MS);

    await publishGatesBundle(
      { boundSources: bound(NOTHING_BOUND) },
      { sourceDir: source, root: gatesRoot },
    );

    expect(await exists(other)).toBe(false);
    expect(await temporaries()).toEqual([]);
  });

  it("keeps another release's unbound directory a boot published within the day", async () => {
    const other = await otherRelease("a");
    await age(other, DAY_MS - MINUTE_MS);

    await publishGatesBundle(
      { boundSources: bound(NOTHING_BOUND) },
      { sourceDir: source, root: gatesRoot },
    );

    expect(await exists(other)).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    "logs, and still publishes, when another release's directory cannot be removed",
    async () => {
      const warnSpy = vi.spyOn(logger, "warn");
      const other = await otherRelease("a");
      const locked = join(other, "locked");
      await mkdir(locked);
      await writeFile(join(locked, "file"), "kept");
      await chmod(locked, 0o555);
      await age(other, 2 * DAY_MS);
      try {
        const published = await publishGatesBundle(
          { boundSources: bound(NOTHING_BOUND) },
          { sourceDir: source, root: gatesRoot },
        );

        expect(await exists(published.hostDir)).toBe(true);
        // Renamed away first, so what is left is a leftover a later boot
        // removes, never a release's directory missing files.
        expect(await exists(other)).toBe(false);
        const [leftover, ...more] = await temporaries();
        expect(more).toEqual([]);
        expect(await exists(join(gatesRoot, `${leftover}`, "locked", "file"))).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ dir: join(gatesRoot, `${leftover}`) }),
          "removing a stale gates bundle failed",
        );
      } finally {
        warnSpy.mockRestore();
        await Promise.all(
          (await temporaries()).map((t) => chmod(join(gatesRoot, t, "locked"), 0o755)),
        );
      }
    },
  );

  it("keeps another release's directory a container binds", async () => {
    const boundDir = await otherRelease("a");
    const boundBelow = await otherRelease("b");
    const unbound = await otherRelease("c");
    await Promise.all([boundDir, boundBelow, unbound].map((dir) => age(dir, 2 * DAY_MS)));

    await publishGatesBundle(
      {
        boundSources: bound(ok(new Set([boundDir, join(boundBelow, "gates.mjs"), "/elsewhere"]))),
      },
      { sourceDir: source, root: gatesRoot },
    );

    expect(await exists(boundDir)).toBe(true);
    expect(await exists(boundBelow)).toBe(true);
    expect(await exists(unbound)).toBe(false);
  });

  it("logs and keeps another release's directory it cannot rename away", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      await publishGatesBundle(
        { boundSources: bound(NOTHING_BOUND) },
        { sourceDir: source, root: gatesRoot },
      );
      const other = await otherRelease("a");
      await age(other, 2 * DAY_MS);
      // This boot reuses its directory, so the removal's is the first rename.
      vi.mocked(rename).mockRejectedValueOnce(fsError("EBUSY"));

      await publishGatesBundle(
        { boundSources: bound(NOTHING_BOUND) },
        { sourceDir: source, root: gatesRoot },
      );

      expect(await exists(join(other, "gates.mjs"))).toBe(true);
      expect(await temporaries()).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: "EBUSY: stood in", dir: other }),
        "removing a stale gates bundle failed",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps, without a word, another release's directory gone before its age is read", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      const other = await otherRelease("a");
      await age(other, 2 * DAY_MS);
      // No temporary directory is there, so the other release's is the first `stat`.
      vi.mocked(stat).mockRejectedValueOnce(fsError("ENOENT"));
      const boundSources = bound(NOTHING_BOUND);

      await publishGatesBundle({ boundSources }, { sourceDir: source, root: gatesRoot });

      expect(await exists(join(other, "gates.mjs"))).toBe(true);
      expect(boundSources).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs and keeps another release's directory whose age cannot be read", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      const other = await otherRelease("a");
      await age(other, 2 * DAY_MS);
      vi.mocked(stat).mockRejectedValueOnce(fsError("EACCES"));

      await publishGatesBundle(
        { boundSources: bound(NOTHING_BOUND) },
        { sourceDir: source, root: gatesRoot },
      );

      expect(await exists(join(other, "gates.mjs"))).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: "EACCES: stood in", dir: other }),
        "reading a gates bundle's age failed",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps every other release's directory when the bound ones cannot be listed", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      const other = await otherRelease("a");
      await age(other, 2 * DAY_MS);

      await publishGatesBundle(
        { boundSources: bound(err("connect ECONNREFUSED")) },
        { sourceDir: source, root: gatesRoot },
      );

      expect(await exists(other)).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: "connect ECONNREFUSED", kept: [other] }),
        expect.stringContaining("keeping every other release's"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("removes a temporary directory a crashed publish left over ten minutes ago, whether or not listing works", async () => {
    const leftover = join(gatesRoot, ".publishing-abc123");
    await mkdir(leftover);
    await writeFile(join(leftover, "gates.mjs"), "half a copy");
    await age(leftover, 10 * MINUTE_MS + MINUTE_MS);

    await publishGatesBundle(
      { boundSources: bound(err("connect ECONNREFUSED")) },
      { sourceDir: source, root: gatesRoot },
    );

    expect(await exists(leftover)).toBe(false);
  });

  it("keeps a temporary directory written within ten minutes, which a live publish may still be filling", async () => {
    const live = join(gatesRoot, ".publishing-live01");
    await mkdir(live);
    await writeFile(join(live, "gates.mjs"), "half a copy");
    await age(live, 10 * MINUTE_MS - MINUTE_MS);

    await publishGatesBundle(
      { boundSources: bound(NOTHING_BOUND) },
      { sourceDir: source, root: gatesRoot },
    );

    expect(await exists(join(live, "gates.mjs"))).toBe(true);
  });

  it("leaves alone what is neither a digest's directory nor its own temporary one", async () => {
    await writeFile(join(gatesRoot, "README"), "the operator's");
    await mkdir(join(gatesRoot, "a".repeat(63)));

    const published = await publishGatesBundle(
      { boundSources: bound(NOTHING_BOUND) },
      { sourceDir: source, root: gatesRoot },
    );

    expect((await readdir(gatesRoot)).sort()).toEqual(
      ["README", "a".repeat(63), published.digest].sort(),
    );
    expect(await readFile(join(gatesRoot, "README"), "utf8")).toBe("the operator's");
  });

  it("asks for the bound directories only when another release's is old enough to remove", async () => {
    const boundSources = bound(NOTHING_BOUND);
    await otherRelease("a");

    await publishGatesBundle({ boundSources }, { sourceDir: source, root: gatesRoot });

    expect(boundSources).not.toHaveBeenCalled();
  });
});
