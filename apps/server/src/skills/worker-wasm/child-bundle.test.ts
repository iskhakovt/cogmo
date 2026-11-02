import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkOwnPrivateDir } from "./child-bundle.js";

describe("checkOwnPrivateDir", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cogmo-child-bundle-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("trusts a directory this user owns with mode 700", async () => {
    const dir = await mkdtemp(join(root, "bundle-"));
    expect((await checkOwnPrivateDir(dir)).isOk()).toBe(true);
  });

  it("refuses a directory others can read or write", async () => {
    const dir = join(root, "open");
    await mkdir(dir);
    await chmod(dir, 0o777);
    expect((await checkOwnPrivateDir(dir))._unsafeUnwrapErr()).toMatch(/mode 777, not 700/);
  });

  it("refuses a link to a private directory", async () => {
    const target = await mkdtemp(join(root, "bundle-"));
    const link = join(root, "link");
    await symlink(target, link);
    expect((await checkOwnPrivateDir(link))._unsafeUnwrapErr()).toMatch(/not a directory/);
  });

  it("refuses a file", async () => {
    const file = join(root, "file");
    await writeFile(file, "");
    expect((await checkOwnPrivateDir(file))._unsafeUnwrapErr()).toMatch(/not a directory/);
  });
});
