import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Result } from "neverthrow";
import * as R from "remeda";
import { logger } from "../logger.js";
import { describeError } from "../util/describe-error.js";
import { GATES_BUNDLE_DIR, GATES_BUNDLE_FILES, gatesBundleDigest } from "./gates-files.js";

/**
 * Where the boot publishes the release's gates bundle for coding sessions on
 * the skills repo (design/skills.md → The gates in verify → Delivery):
 * `$SANDBOX_GATES_DIR/<digest>/`, which Local-Docker binds and Daytona's
 * upload reads. One `cogmo serve` uses a root at a time; another release's
 * process on the same root may lose its directory.
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

/**
 * The prefix of the temporary directory a publish writes before its rename,
 * and a removal renames a release's directory to before it removes it.
 */
const PUBLISHING_PREFIX = ".publishing-";

/** A directory named by a digest: a published release's. */
const DIGEST_NAME = /^[0-9a-f]{64}$/;

/** How old a temporary directory is before it is taken for a crash's leftover; a publish takes about a second. */
const LEFTOVER_AGE_MS = 10 * 60_000;

/**
 * How long another release's directory stays after the boot that last
 * published or reused it, bound or not, for a process of that release still
 * running on the root.
 */
const RETENTION_MS = 24 * 60 * 60_000;

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
    const { buildGatesBundleFromSource } = await import("./gates-bundle-source.js");
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
 * temporary directory under `root` and renamed into place, so the digest's
 * directory is whole or absent. A directory the digest already names is kept
 * once its bytes match. Either way it is opened to every user (the directory
 * 0755, each file 0644, since a session's user may not be the server's), and
 * its mtime set to now, which another release's boot reads as its age. Then
 * it removes each temporary directory over `LEFTOVER_AGE_MS` old, and each
 * other release's directory over `RETENTION_MS` old that no container binds.
 * Throws when the copy or rename fails, or the digest's directory holds other
 * bytes; a removal that fails is logged and left for a later boot.
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
  await Promise.all(GATES_BUNDLE_FILES.map((file) => chmod(join(hostDir, file), 0o644)));
  await chmod(hostDir, 0o755);
  const now = new Date();
  await utimes(hostDir, now, now);
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
      GATES_BUNDLE_FILES.map((file) => copyFile(join(sourceDir, file), join(temp, file))),
    );
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
  const refuse = (why: string, cause?: unknown) =>
    new Error(`${hostDir} does not hold the gates bundle its name digests (${why}); remove it`, {
      cause,
    });
  const found = await gatesBundleDigest(hostDir).catch((e: unknown) => {
    throw refuse(describeError(e), e);
  });
  if (found !== digest) throw refuse(`its files digest to ${found}`);
}

/**
 * Remove each temporary directory under `root` old enough to be a crash's
 * leftover, and each other release's directory past its retention that no
 * container binds.
 */
async function removeStale(
  deps: PublishGatesBundleDeps,
  root: string,
  digest: string,
): Promise<void> {
  const now = Date.now();
  const names = await readdir(root);
  const leftovers = await olderThan(
    names.filter((n) => n.startsWith(PUBLISHING_PREFIX)).map((n) => join(root, n)),
    now - LEFTOVER_AGE_MS,
  );
  await Promise.all(leftovers.map(removeDir));
  const others = await olderThan(
    names.filter((n) => DIGEST_NAME.test(n) && n !== digest).map((n) => join(root, n)),
    now - RETENTION_MS,
  );
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
  await Promise.all(unbound.map((dir) => retire(root, dir)));
}

/**
 * Rename a release's directory to a temporary name, then remove it, so a
 * crash part-way leaves a leftover a later boot removes, never a release's
 * directory missing files that a rollback to it would refuse.
 */
async function retire(root: string, dir: string): Promise<void> {
  const leftover = join(root, `${PUBLISHING_PREFIX}${randomBytes(8).toString("hex")}`);
  const renamed = await rename(dir, leftover).then(
    () => true,
    (e: unknown) => {
      log.warn({ err: describeError(e), dir }, "removing a stale gates bundle failed");
      return false;
    },
  );
  if (renamed) await removeDir(leftover);
}

/** The directories of `dirs` last modified before `cutoffMs`; one that cannot be read is logged and left. */
async function olderThan(dirs: readonly string[], cutoffMs: number): Promise<string[]> {
  const mtimes = await Promise.all(
    dirs.map((dir) =>
      stat(dir).then(
        (s) => s.mtimeMs,
        (e: unknown) => {
          if (!hasCode(e, "ENOENT")) {
            log.warn({ err: describeError(e), dir }, "reading a gates bundle's age failed");
          }
          return null;
        },
      ),
    ),
  );
  return R.zip(dirs, mtimes).flatMap(([dir, mtime]) =>
    mtime !== null && mtime < cutoffMs ? [dir] : [],
  );
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
