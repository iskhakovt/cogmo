import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { expectDefined } from "../test/assertions.js";
import { buildGatesBundle } from "./gates-bundle.js";
import { buildGatesBundleFromSource } from "./gates-bundle-source.js";
import { GATES_BUNDLE_FILES, gatesBundleDigest } from "./gates-files.js";

// A build that writes bytes of this run's own, so the directory its digest
// names is this file's alone, and never one a concurrent boot from source uses.
vi.mock("./gates-bundle.js", () => ({ buildGatesBundle: vi.fn() }));

const RUN = randomUUID();
let published: string | undefined;

beforeEach(() => {
  vi.mocked(buildGatesBundle).mockImplementation(async ({ outDir }) => {
    await mkdir(outDir, { recursive: true });
    await Promise.all(
      GATES_BUNDLE_FILES.map((file) => writeFile(join(outDir, file), `${RUN} ${file}`)),
    );
  });
});

afterAll(async () => {
  if (published !== undefined) await rm(published, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("buildGatesBundleFromSource", () => {
  it("builds this source tree into the temporary directory its digest names", async () => {
    published = await buildGatesBundleFromSource();
    const digest = await gatesBundleDigest(published);

    expect(published).toBe(join(await realpath(tmpdir()), `cogmo-gates-${digest.slice(0, 16)}`));
    expect((await readdir(published)).sort()).toEqual([...GATES_BUNDLE_FILES].sort());
    const call = expectDefined(vi.mocked(buildGatesBundle).mock.calls[0], "the build")[0];
    expect(resolve(call.serverRoot)).toBe(process.cwd());
  });

  it("shares the published directory with a later build of the same sources", async () => {
    const first = await buildGatesBundleFromSource();
    published = first;

    expect(await buildGatesBundleFromSource()).toBe(first);
    const builds = vi.mocked(buildGatesBundle).mock.calls.map(([opts]) => opts.outDir);
    expect(builds).toHaveLength(2);
    expect(await Promise.all(builds.map(exists))).toEqual([false, false]);
  });

  it("removes its build directory and rethrows when the build fails", async () => {
    vi.mocked(buildGatesBundle).mockImplementationOnce(async ({ outDir }) => {
      await writeFile(join(outDir, "gates.mjs"), "half a build");
      throw new Error("esbuild failed");
    });

    await expect(buildGatesBundleFromSource()).rejects.toThrow("esbuild failed");
    const call = expectDefined(vi.mocked(buildGatesBundle).mock.calls[0], "the build")[0];
    expect(await exists(call.outDir)).toBe(false);
  });

  it("refuses a directory of that name it cannot trust", async () => {
    const first = await buildGatesBundleFromSource();
    published = first;
    await rm(first, { recursive: true, force: true });
    await mkdir(first);
    await writeFile(join(first, "gates.mjs"), "planted");
    await chmod(first, 0o755);

    await expect(buildGatesBundleFromSource()).rejects.toThrow(
      `refusing the gates bundle at ${first}: ${first} has mode 755, not 700`,
    );
  });
});
