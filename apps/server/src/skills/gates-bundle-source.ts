import { mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGatesBundle } from "./gates-bundle.js";
import { gatesBundleDigest } from "./gates-files.js";
import { assertOwnPrivateDir } from "./worker-wasm/child-bundle.js";

/**
 * Build the bundle from this source tree into a temporary directory named by
 * its digest, so processes share one copy per version of the sources, and
 * return that directory. The first process to publish a digest wins; a later
 * one drops its own build and uses the winner's only if it is this user's
 * private directory, since anyone can create a name in the shared temporary
 * directory first. Throws when the build or the filesystem fails, or the
 * winner's directory is not one this user can trust.
 */
export async function buildGatesBundleFromSource(): Promise<string> {
  const root = await realpath(tmpdir());
  const buildDir = await mkdtemp(join(root, "cogmo-gates-build-"));
  try {
    await buildGatesBundle({
      serverRoot: fileURLToPath(new URL("../../", import.meta.url)),
      outDir: buildDir,
    });
  } catch (e) {
    await rm(buildDir, { recursive: true, force: true });
    throw e;
  }
  const digest = await gatesBundleDigest(buildDir);
  const outDir = join(root, `cogmo-gates-${digest.slice(0, 16)}`);
  try {
    await rename(buildDir, outDir);
  } catch (e) {
    const code = e instanceof Error && "code" in e ? e.code : undefined;
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw e;
    await rm(buildDir, { recursive: true, force: true });
    await assertOwnPrivateDir(outDir, "the gates bundle");
  }
  return outDir;
}
