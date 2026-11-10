import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { err, ok, type Result } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { GATES_BUNDLE_FILES, gatesBundleDigest } from "./gates-files.js";
import { publishGatesBundle, releaseGatesBundle } from "./publish-gates-bundle.js";

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

  it("removes another release's directory no container binds", async () => {
    const other = await otherRelease("a");

    await publishGatesBundle(
      { boundSources: bound(NOTHING_BOUND) },
      { sourceDir: source, root: gatesRoot },
    );

    expect(await exists(other)).toBe(false);
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
      try {
        const published = await publishGatesBundle(
          { boundSources: bound(NOTHING_BOUND) },
          { sourceDir: source, root: gatesRoot },
        );

        expect(await exists(published.hostDir)).toBe(true);
        expect(await exists(join(locked, "file"))).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ dir: other }),
          "removing a stale gates bundle failed",
        );
      } finally {
        warnSpy.mockRestore();
        await chmod(locked, 0o755);
      }
    },
  );

  it("keeps another release's directory a container binds", async () => {
    const boundDir = await otherRelease("a");
    const boundBelow = await otherRelease("b");
    const unbound = await otherRelease("c");

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

  it("keeps every other release's directory when the bound ones cannot be listed", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      const other = await otherRelease("a");

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

  it("removes a temporary directory a crashed publish left, whether or not listing works", async () => {
    const leftover = join(gatesRoot, ".publishing-abc123");
    await mkdir(leftover);
    await writeFile(join(leftover, "gates.mjs"), "half a copy");

    await publishGatesBundle(
      { boundSources: bound(err("connect ECONNREFUSED")) },
      { sourceDir: source, root: gatesRoot },
    );

    expect(await exists(leftover)).toBe(false);
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

  it("asks for the bound directories only when another release's is there to remove", async () => {
    const boundSources = bound(NOTHING_BOUND);

    await publishGatesBundle({ boundSources }, { sourceDir: source, root: gatesRoot });

    expect(boundSources).not.toHaveBeenCalled();
  });
});
