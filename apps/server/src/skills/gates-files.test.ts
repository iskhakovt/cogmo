import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATES_BUNDLE_FILES, gatesBundleDigest } from "./gates-files.js";

let root: string;
/** A directory holding each of the bundle's files, with bytes of its own. */
let bundle: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cogmo-gates-files-"));
  bundle = join(root, "bundle");
  await mkdir(bundle);
  await Promise.all(
    GATES_BUNDLE_FILES.map((file) => writeFile(join(bundle, file), `the bytes of ${file}`)),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function copyOfBundle(): Promise<string> {
  const copy = await mkdtemp(join(root, "copy-"));
  await cp(bundle, copy, { recursive: true });
  return copy;
}

describe("gatesBundleDigest", () => {
  it("is a sha256 in hex", async () => {
    expect(await gatesBundleDigest(bundle)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(GATES_BUNDLE_FILES)("changes with a byte of %s", async (file) => {
    const copy = await copyOfBundle();
    await writeFile(join(copy, file), "changed");

    expect(await gatesBundleDigest(copy)).not.toBe(await gatesBundleDigest(bundle));
  });

  it("changes when bytes move from one file to the next", async () => {
    const [first, second] = GATES_BUNDLE_FILES;
    const copy = await copyOfBundle();
    await writeFile(join(copy, first), "ab");
    await writeFile(join(copy, second), "c");
    const moved = await copyOfBundle();
    await writeFile(join(moved, first), "a");
    await writeFile(join(moved, second), "bc");

    expect(await gatesBundleDigest(copy)).not.toBe(await gatesBundleDigest(moved));
  });

  it("reads only the bundle's files", async () => {
    const copy = await copyOfBundle();
    await writeFile(join(copy, "notes.txt"), "not the bundle's");

    expect(await gatesBundleDigest(copy)).toBe(await gatesBundleDigest(bundle));
  });

  it("throws naming a file the directory lacks", async () => {
    const copy = await copyOfBundle();
    await rm(join(copy, "tree-sitter-python.wasm"));

    await expect(gatesBundleDigest(copy)).rejects.toThrow(join(copy, "tree-sitter-python.wasm"));
  });
});
