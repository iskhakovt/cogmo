import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { describe, expect, it } from "vitest";

/**
 * Declared-runtime consistency guard.
 *
 * `engines.node` is a promise to whoever installs the published package. It is
 * only as good as its narrowest runtime dependency: if a dependency requires a
 * newer Node than we advertise, an install on a Node inside our range hits an
 * engine mismatch on a package the app needs to run — a warning by default, a
 * hard failure under `engine-strict`.
 *
 * Nothing enforces that on its own. `pnpm update --latest` treats a dependency
 * that raised its Node floor like any other bump, and no tier notices because
 * `engines` is metadata rather than something the code reads. jsdom 30 did
 * exactly this: it moved to `^22.22.2 || ^24.15.0 || >=26.0.0` while both
 * manifests still said `>=24`, leaving Node 24.0–24.14 admitted by us and
 * refused by it.
 *
 * When this fails, either raise `engines.node` in BOTH manifests to a range the
 * dependency accepts, or hold the dependency back. Prefer the former — the
 * failure means we were advertising support we didn't have.
 */

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root (pnpm-workspace.yaml) not found");
    dir = parent;
  }
  return dir;
}

const ROOT = repoRoot();
const SERVER_PKG_DIR = join(ROOT, "apps", "server");

interface Manifest {
  dependencies?: Record<string, string>;
  engines?: { node?: string };
}

function manifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

const serverPkg = manifest(join(SERVER_PKG_DIR, "package.json"));
const rootPkg = manifest(join(ROOT, "package.json"));

/**
 * Node majors to probe. `semver.subset` would be tidier but treats an
 * open-ended `>=` range as unbounded, which makes every future major a
 * failure the moment a dependency caps its upper bound. Sampling the majors
 * we could plausibly run answers the question that actually matters: is there
 * a Node we tell people to use that a runtime dependency rejects?
 */
const PROBE_VERSIONS = [
  "24.0.0",
  "24.14.0",
  "24.15.0",
  "24.99.0",
  "25.0.0",
  "26.0.0",
  "27.0.0",
] as const;

describe("engines.node stays within every runtime dependency's range", () => {
  it("both manifests declare the same range", () => {
    expect(serverPkg.engines?.node).toBe(rootPkg.engines?.node);
  });

  it("no runtime dependency rejects a Node version we advertise", () => {
    const ours = serverPkg.engines?.node;
    expect(ours, "apps/server/package.json must declare engines.node").toBeDefined();
    if (!ours) return;

    const require = createRequire(join(SERVER_PKG_DIR, "package.json"));
    const conflicts: string[] = [];

    for (const dep of Object.keys(serverPkg.dependencies ?? {})) {
      let depEngines: string | undefined;
      try {
        const depPkgPath = require.resolve(`${dep}/package.json`);
        depEngines = manifest(depPkgPath).engines?.node;
      } catch {
        // Not every package exports its own manifest, and workspace links
        // resolve elsewhere. An unreadable dependency can't be checked; it
        // also can't be the source of a mismatch we could act on here.
        continue;
      }
      if (!depEngines) continue;

      for (const v of PROBE_VERSIONS) {
        if (semver.satisfies(v, ours) && !semver.satisfies(v, depEngines)) {
          conflicts.push(`${dep} (${depEngines}) rejects Node ${v}, which "${ours}" admits`);
        }
      }
    }

    expect(conflicts).toEqual([]);
  });
});
