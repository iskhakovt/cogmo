import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Declared-runtime consistency guard.
 *
 * `engines.node` is a promise to whoever installs the published package. It is
 * only as good as its narrowest dependency, at any depth: if anything in the
 * resolved graph requires a newer Node than we advertise, an install on a Node
 * inside our range hits an engine mismatch on a package the app needs — a
 * warning by default, a hard failure under `engineStrict`.
 *
 * Nothing enforces that on its own. `pnpm update --latest` treats a dependency
 * that raised its Node floor like any other bump, and no tier notices because
 * `engines` is metadata rather than something the code reads. jsdom 30 did
 * exactly this: it moved to `^22.22.2 || ^24.15.0 || >=26.0.0` while both
 * manifests still said `>=24`, leaving Node 24.0–24.14 admitted by us and
 * refused by it.
 *
 * The check is `semver.subset`: every Node version our range admits must also
 * be admitted by each dependency's range. `pnpm-lock.yaml` already records
 * `engines` per resolved package, transitive dependencies included, so the
 * resolved graph is the input — no `node_modules` walk, no network, and no
 * version sampling that could step over a gap.
 *
 * Two mechanisms that look like they would cover this do not. pnpm's
 * `engineStrict` compares a single Node version against the graph, so it can
 * only ever answer a point query about the interpreter in hand — and on pnpm
 * 11.21.0 a dependency requiring `node>=99` installs on Node 24.18 with no
 * diagnostic and exit 0 whether it is declared directly or transitively.
 * `ls-engines` does intersect the graph, but it collapses an `||`-gapped
 * intersection to `>= <lowest>` (ljharb/ls-engines#32), so it calls
 * `>=24.15.0` an exact match of a graph containing jsdom 30 even though that
 * range admits Node 25 and jsdom rejects it.
 *
 * When this fails, either raise `engines.node` in BOTH manifests to a range
 * every dependency accepts, or hold the offending dependency back. Prefer the
 * former — the failure means we were advertising support we didn't have.
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

const ManifestSchema = z
  .object({ engines: z.object({ node: z.string() }).partial().optional() })
  .passthrough();

function manifest(path: string) {
  return ManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Only the fields this guard reads. Everything else in the lockfile is
 * incidental here, so the entry stays open rather than enumerating a schema
 * that pnpm owns and revises.
 */
const LockfileSchema = z.object({
  packages: z
    .record(
      z.string(),
      z.object({ engines: z.object({ node: z.string() }).partial().optional() }).passthrough(),
    )
    .optional(),
});

const serverPkg = manifest(join(SERVER_PKG_DIR, "package.json"));
const rootPkg = manifest(join(ROOT, "package.json"));

interface DependencyRange {
  id: string;
  range: string;
}

function declaredNodeRanges(): DependencyRange[] {
  const lockfile = LockfileSchema.parse(
    parseYaml(readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8")),
  );
  const ranges: DependencyRange[] = [];
  for (const [id, entry] of Object.entries(lockfile.packages ?? {})) {
    const range = entry.engines?.node;
    if (range === undefined) continue;
    // An unparseable range carries no constraint we can evaluate, and there
    // is nothing to act on either way.
    if (semver.validRange(range) === null) continue;
    ranges.push({ id, range });
  }
  return ranges;
}

// `includePrerelease` is deliberately absent from the subset call: it makes
// subset treat prereleases of every admitted major as in-range and reports
// conflicts against dependencies that in fact accept the whole stable range.
function conflicts(ours: string, ranges: readonly DependencyRange[]): string[] {
  return ranges
    .filter(({ range }) => !semver.subset(ours, range))
    .map(({ id, range }) => `${id} (${range}) rejects part of "${ours}"`);
}

describe("engines.node stays within every dependency's range", () => {
  it("both manifests declare the same range", () => {
    // The root range governs a workspace install, the server range travels
    // with the published package; the check below reads the server's.
    expect(serverPkg.engines?.node).toBe(rootPkg.engines?.node);
  });

  it("no dependency in the resolved graph rejects a Node version we advertise", () => {
    const ours = serverPkg.engines?.node;
    expect(ours, "apps/server/package.json must declare engines.node").toBeDefined();
    if (ours === undefined) return;

    const ranges = declaredNodeRanges();

    // Guards the guard: a lockfile whose shape moved out from under the
    // schema would otherwise make the assertion below vacuously pass.
    expect(ranges.length).toBeGreaterThan(400);

    expect(conflicts(ours, ranges)).toEqual([]);
  });

  it("flags a declared range that admits a Node version a dependency excludes", () => {
    // A fixed range rather than the lockfile's: naming a package that happens
    // to be installed today would turn any routine dependency change into a
    // failure here, and the claim under test is about `conflicts`, not about
    // who currently ships a gap.
    //
    // The shape is what matters — a hole in the middle of an `||` range.
    // jsdom 30's `^22.22.2 || ^24.15.0 || >=26.0.0` is the real instance that
    // motivated this guard, and the same shape is what `ls-engines` reports as
    // an exact match for `>=24.15.0` (ljharb/ls-engines#32).
    const gapped = [{ id: "example@1.0.0", range: "^22.22.2 || ^24.15.0 || >=26.0.0" }];

    // `>=24.15.0` admits Node 25, which the dependency refuses.
    expect(conflicts(">=24.15.0", gapped)).toHaveLength(1);
    // Our actual shape steps over the hole.
    expect(conflicts("^24.15.0 || >=26.0.0", gapped)).toEqual([]);
  });

  it("can flag something in the real graph", () => {
    // Keeps the lockfile-backed path honest without depending on any package
    // in particular: a range this wide is refused by essentially every
    // published dependency, so an empty result here means `declaredNodeRanges`
    // stopped producing usable ranges and the assertion above is passing
    // vacuously.
    expect(conflicts(">=1.0.0", declaredNodeRanges())).not.toEqual([]);
  });
});
