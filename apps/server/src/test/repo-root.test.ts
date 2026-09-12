import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./repo-root.js";

/**
 * Layout canary for the files the test tiers reach for outside their own
 * package.
 *
 * Every consumer fails quietly when the path is wrong: `loadRootEnv` reads an
 * absent `.env` as "not recording" and returns, the e2e image build sits behind
 * an `E2E_IMAGE` check that CI always satisfies, and `skill-authoring` only
 * builds its devbase snapshot in record mode. Any of them could point at
 * nothing for a release without turning a build red.
 *
 * So assert on real files, one per consumer target.
 */
describe("repoRoot", () => {
  const root = repoRoot();

  it("is the directory the cwd is not — which is why callers name it", () => {
    // The unit tier runs with the cwd at `apps/server`, the package that owns
    // the Vitest config. A bake invocation or `.env` path resolved against
    // that instead of the root lands in a directory holding neither.
    expect(root).not.toBe(process.cwd());
    expect(existsSync(join(process.cwd(), "Dockerfile"))).toBe(false);
  });

  it("carries the bake file the e2e build runs, and the inputs that target names", () => {
    // `repoRoot()` is the cwd `docker buildx bake --file docker-bake.hcl`
    // runs in, and the target's `context = "."` resolves against the bake
    // file's own directory — so both land here.
    expect(existsSync(join(root, "docker-bake.hcl"))).toBe(true);
    expect(existsSync(join(root, "Dockerfile"))).toBe(true);
    expect(existsSync(join(root, ".dockerignore"))).toBe(true);
  });

  it("carries the .env loadRootEnv reads in record mode", () => {
    // `.env` itself is gitignored and absent on a fresh clone, so anchor on the
    // committed example that sits beside it.
    expect(existsSync(join(root, ".env.example"))).toBe(true);
  });

  it("carries the devbase Dockerfile skill-authoring builds its snapshot from", () => {
    expect(existsSync(join(root, "images", "devbase", "Dockerfile"))).toBe(true);
  });

  it("sits above the server package rather than inside it", () => {
    expect(existsSync(join(root, "apps", "server", "package.json"))).toBe(true);
  });
});
