import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertOwnPrivateDir } from "./child-bundle.js";

describe("assertOwnPrivateDir", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cogmo-child-bundle-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("trusts a directory this user owns with mode 700", async () => {
    const dir = await mkdtemp(join(root, "bundle-"));
    await expect(assertOwnPrivateDir(dir)).resolves.toBeUndefined();
  });

  it("refuses a directory others can read or write", async () => {
    const dir = join(root, "open");
    await mkdir(dir);
    await chmod(dir, 0o777);
    await expect(assertOwnPrivateDir(dir)).rejects.toThrow(
      `refusing the tier-1 child bundle at ${dir}: ${dir} has mode 777, not 700`,
    );
  });

  it("refuses a link to a private directory", async () => {
    const target = await mkdtemp(join(root, "bundle-"));
    const link = join(root, "link");
    await symlink(target, link);
    await expect(assertOwnPrivateDir(link)).rejects.toThrow(/not a directory of its own/);
  });

  it("refuses a file", async () => {
    const file = join(root, "file");
    await writeFile(file, "");
    await expect(assertOwnPrivateDir(file)).rejects.toThrow(/not a directory of its own/);
  });
});
