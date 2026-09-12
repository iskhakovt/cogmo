import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./repo-root.js";

/**
 * Layout canary for the files the test tiers reach for outside their own
 * package.
 *
 * Both consumers outside `src/` fail quietly when the path is wrong:
 * `loadRootEnv` reads an absent `.env` as "not recording" and returns, and the
 * e2e image build sits behind an `E2E_IMAGE` check that CI always satisfies, so
 * its branch never runs there. Either could point at nothing for a release
 * without a red build.
 *
 * So assert on real files, each one an actual consumer's target.
 */
describe("repoRoot", () => {
  const root = repoRoot();

  it("is absolute, so it holds wherever the caller is launched from", () => {
    expect(isAbsolute(root)).toBe(true);
  });

  it("carries the Dockerfile and .dockerignore the e2e build passes as its context", () => {
    expect(existsSync(join(root, "Dockerfile"))).toBe(true);
    expect(existsSync(join(root, ".dockerignore"))).toBe(true);
  });

  it("sits above the server package rather than inside it", () => {
    expect(existsSync(join(root, "apps", "server", "package.json"))).toBe(true);
  });
});
