import { chmod, copyFile, lstat, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Result, ResultAsync } from "neverthrow";
import * as R from "remeda";
import { logger } from "../logger.js";
import { describeError } from "../util/describe-error.js";
import { GATES_BUNDLE_DIR, GATES_BUNDLE_FILES, gatesBundleDigest } from "./gates-files.js";

/**
 * Where the boot publishes the release's gates bundle for coding sessions on
 * the skills repo (design/skills.md → The gates in verify → Delivery):
 * `$SANDBOX_GATES_DIR/<digest>/`, which Local-Docker binds and Daytona's
 * upload reads.
 */

const log = logger.child({ component: "skills.gates" });

/** The release's gates bundle, as published. */
export interface PublishedGatesBundle {
  /** `<root>/<digest>`, holding the bundle's files. */
  hostDir: string;
  digest: string;
}

export interface PublishGatesBundleDeps {
  /**
   * The host paths the backend's containers bind, which the publish never
   * removes; why not, when they cannot be listed, and then it removes no
   * other release's directory.
   */
  boundSources(): Promise<Result<ReadonlySet<string>, string>>;
}

/** The prefix of the temporary directory a publish writes before its rename. */
const PUBLISHING_PREFIX = ".publishing-";

/** A directory named by a digest: a published release's. */
const DIGEST_NAME = /^[0-9a-f]{64}$/;

/**
 * The directory holding the release's gates bundle. `moduleUrl` is the
 * caller's `import.meta.url`: in a built server, a module at the root of
 * `dist/`, beside which the build writes `skills-gates/`; from source, a
 * `.ts` file, and the bundle is built into a temporary directory
 * (`buildGatesBundleFromSource`, imported only then, since a deployed server
 * has no esbuild). A fatal boot check: throws naming each file the built
 * server's bundle lacks.
 */
export async function releaseGatesBundle(moduleUrl: string): Promise<string> {
  if (moduleUrl.endsWith(".ts")) {
    const { buildGatesBundleFromSource } = await import("./gates-bundle.js");
    return buildGatesBundleFromSource();
  }
  const dir = fileURLToPath(new URL(`./${GATES_BUNDLE_DIR}`, moduleUrl));
  const present = await Promise.all(GATES_BUNDLE_FILES.map((f) => isFile(join(dir, f))));
  const missing = R.zip(GATES_BUNDLE_FILES, present).flatMap(([f, isPresent]) =>
    isPresent ? [] : [join(dir, f)],
  );
  if (missing.length > 0) {
    throw new Error(`the release's gates bundle lacks ${missing.join(", ")}`);
  }
  return dir;
}

/**
 * Publish the bundle in `sourceDir` to `<root>/<digest>/`: copied into a
 * temporary directory under `root`, opened to every user (the directory
 * 0755, each file 0644, since a session's user may not be the server's), then
 * renamed into place, so the digest's directory is whole or absent. A
 * directory the digest already names is kept once its bytes match. Then it
 * removes what a crashed publish left, and every other release's directory no
 * container binds. Throws when the copy or rename fails, or the digest's
 * directory holds other bytes; a removal that fails is logged and left for a
 * later boot.
 */
export async function publishGatesBundle(
  deps: PublishGatesBundleDeps,
  args: { sourceDir: string; root: string },
): Promise<PublishedGatesBundle> {
  const root = resolve(args.root);
  const digest = await gatesBundleDigest(args.sourceDir);
  const hostDir = join(root, digest);
  if (await exists(hostDir)) {
    await assertHolds(hostDir, digest);
  } else {
    await publishInto(args.sourceDir, root, hostDir, digest);
  }
  await removeStale(deps, root, digest);
  log.info({ hostDir, digest }, "published the gates bundle");
  return { hostDir, digest };
}

async function publishInto(
  sourceDir: string,
  root: string,
  hostDir: string,
  digest: string,
): Promise<void> {
  const temp = await mkdtemp(join(root, PUBLISHING_PREFIX));
  try {
    await Promise.all(
      GATES_BUNDLE_FILES.map(async (file) => {
        await copyFile(join(sourceDir, file), join(temp, file));
        await chmod(join(temp, file), 0o644);
      }),
    );
    await chmod(temp, 0o755);
    await rename(temp, hostDir);
  } catch (e) {
    await rm(temp, { recursive: true, force: true });
    // Another publish of the same release renamed its copy first.
    if (!hasCode(e, "EEXIST") && !hasCode(e, "ENOTEMPTY")) throw e;
    await assertHolds(hostDir, digest);
  }
}

/** Throw unless `hostDir` holds the bundle `digest` names. A fatal boot check. */
async function assertHolds(hostDir: string, digest: string): Promise<void> {
  const held = await ResultAsync.fromPromise(gatesBundleDigest(hostDir), describeError);
  const mismatch = held.match(
    (found) => (found === digest ? null : `its files digest to ${found}`),
    (unreadable) => unreadable,
  );
  if (mismatch !== null) {
    throw new Error(
      `${hostDir} does not hold the gates bundle its name digests (${mismatch}); remove it`,
    );
  }
}

/**
 * Remove each temporary directory under `root`, which no session ever reads,
 * and each other release's directory no container binds.
 */
async function removeStale(
  deps: PublishGatesBundleDeps,
  root: string,
  digest: string,
): Promise<void> {
  const names = await readdir(root);
  await Promise.all(
    names.filter((n) => n.startsWith(PUBLISHING_PREFIX)).map((n) => removeDir(join(root, n))),
  );
  const others = names.filter((n) => DIGEST_NAME.test(n) && n !== digest).map((n) => join(root, n));
  if (others.length === 0) return;
  const bound = await deps.boundSources();
  if (bound.isErr()) {
    log.warn(
      { err: bound.error, kept: others },
      "cannot list the containers' binds; keeping every other release's gates bundle",
    );
    return;
  }
  const sources = [...bound.value];
  const [kept, unbound] = R.partition(others, (dir) =>
    sources.some((s) => s === dir || s.startsWith(`${dir}${sep}`)),
  );
  if (kept.length > 0) {
    log.info({ kept }, "keeping the gates bundles containers still bind");
  }
  await Promise.all(unbound.map(removeDir));
}

async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch((e: unknown) => {
    log.warn({ err: describeError(e), dir }, "removing a stale gates bundle failed");
  });
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (e: unknown) => {
      if (hasCode(e, "ENOENT")) return false;
      throw e;
    },
  );
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    (e: unknown) => {
      if (hasCode(e, "ENOENT")) return false;
      throw e;
    },
  );
}

function hasCode(e: unknown, code: string): boolean {
  return e instanceof Error && "code" in e && e.code === code;
}
