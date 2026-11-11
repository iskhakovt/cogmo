import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGatesBundle } from "./gates-bundle.js";
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
