import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGatesBundle, buildGatesBundleFromSource } from "./gates-bundle.js";
import { GATES_BUNDLE_FILES, gatesBundleDigest } from "./gates-files.js";

/** Building the bundle; generous so a loaded runner doesn't fail it on time. */
const BUILD_TIMEOUT_MS = 120_000;

let root: string;
let built: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cogmo-gates-bundle-"));
  built = join(root, "built");
  await buildGatesBundle({ serverRoot: process.cwd(), outDir: built });
}, BUILD_TIMEOUT_MS);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("buildGatesBundle", () => {
  it("writes the three files, and nothing else", async () => {
    expect((await readdir(built)).sort()).toEqual([...GATES_BUNDLE_FILES].sort());
  });

  it(
    "writes the same bytes on every build of the same sources",
    async () => {
      const again = join(root, "again");
      await buildGatesBundle({ serverRoot: process.cwd(), outDir: again });

      expect(await gatesBundleDigest(again)).toBe(await gatesBundleDigest(built));
    },
    BUILD_TIMEOUT_MS,
  );
});

describe("buildGatesBundleFromSource", () => {
  let published: string;

  beforeAll(async () => {
    published = await buildGatesBundleFromSource();
  }, BUILD_TIMEOUT_MS);

  afterAll(async () => {
    await rm(published, { recursive: true, force: true });
  });

  it("publishes the bundle under the temporary directory, named by its digest", async () => {
    const digest = await gatesBundleDigest(published);

    expect(published).toBe(join(await realpath(tmpdir()), `cogmo-gates-${digest.slice(0, 16)}`));
    expect(digest).toBe(await gatesBundleDigest(built));
    expect((await readdir(published)).sort()).toEqual([...GATES_BUNDLE_FILES].sort());
  });

  it(
    "shares the published directory with a later build of the same sources",
    async () => {
      expect(await buildGatesBundleFromSource()).toBe(published);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "refuses a directory of that name it cannot trust",
    async () => {
      await rm(published, { recursive: true, force: true });
      await mkdir(published);
      await writeFile(join(published, "gates.mjs"), "planted");
      await chmod(published, 0o755);

      await expect(buildGatesBundleFromSource()).rejects.toThrow(
        `refusing the gates bundle at ${published}: ${published} has mode 755, not 700`,
      );
    },
    BUILD_TIMEOUT_MS,
  );
});
