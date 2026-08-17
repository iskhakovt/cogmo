import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Declared-runtime consistency guard.
 *
 * `engines.node` is a promise to whoever installs the published package. It is
 * only as good as its narrowest dependency, at any depth: if anything in the
 * installed tree requires a newer Node than we advertise, an install on a Node
 * inside our range hits an engine mismatch on a package the app needs.
 *
 * Nothing enforces that on its own. `pnpm update --latest` treats a dependency
 * that raised its Node floor like any other bump, and no tier notices because
 * `engines` is metadata rather than something the code reads. jsdom 30 did
 * exactly this: it moved to `^22.22.2 || ^24.15.0 || >=26.0.0` while both
 * manifests still said `>=24`, leaving Node 24.0–24.14 admitted by us and
 * refused by it.
 *
 * The comparison itself is `ls-engines`, which intersects `engines.node` across
 * the whole installed graph and exits non-zero when our declared range is wider
 * than that intersection. `--mode=actual` reads the tree from `node_modules`,
 * so it understands pnpm's layout without parsing the lockfile. pnpm's own
 * `engine-strict` is not a substitute: it only compares the current project's
 * `engines` against the running interpreter, ignores dependency `engines`
 * entirely, and warns rather than failing.
 *
 * When this fails, either raise `engines.node` in BOTH manifests to a range
 * every dependency accepts, or hold the offending dependency back. Prefer the
 * former — the failure means we were advertising support we didn't have.
 * `pnpm --filter cogmo engines:check` reproduces it, and `ls-engines --save`
 * prints the range the graph actually supports.
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
  engines?: { node?: string };
}

function manifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

const serverPkg = manifest(join(SERVER_PKG_DIR, "package.json"));
const rootPkg = manifest(join(ROOT, "package.json"));

describe("engines.node stays within every dependency's range", () => {
  it("both manifests declare the same range", () => {
    // ls-engines checks one package at a time; keeping the two in step is
    // ours to assert. The root range governs a workspace install, the server
    // range travels with the published package.
    expect(serverPkg.engines?.node).toBe(rootPkg.engines?.node);
  });

  it("no dependency in the installed graph rejects a Node version we advertise", () => {
    const binary = join(SERVER_PKG_DIR, "node_modules", ".bin", "ls-engines");
    expect(
      existsSync(binary),
      "ls-engines is a devDependency of apps/server — run pnpm install",
    ).toBe(true);

    let output: string;
    try {
      // --dev covers devDependencies too: they never reach a consumer, but
      // they do decide whether a contributor on the low end of our advertised
      // range can install the workspace at all.
      // --no-current drops the "does the running interpreter qualify" check,
      // which asks a different question and needs the network to enumerate
      // published Node releases.
      output = execFileSync(binary, ["--mode=actual", "--dev", "--no-current"], {
        cwd: SERVER_PKG_DIR,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const failure = err as { stdout?: string; stderr?: string };
      throw new Error(
        `ls-engines rejected the declared engines.node range:\n${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      );
    }

    // A wider declared range than the graph supports is the failure mode, and
    // it exits non-zero. Declaring a narrower range is safe and only informs.
    expect(output).not.toMatch(/allows more node versions/);
  }, 60_000);
});
