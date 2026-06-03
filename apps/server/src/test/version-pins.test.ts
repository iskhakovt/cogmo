import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Cross-file version-pin consistency guard.
 *
 * `docker-bake.hcl` is the source of truth for the task images' toolchain
 * pins and overrides them at build time. The devbase Dockerfile also carries
 * defaults (so the standalone `Image.fromDockerfile` build in
 * skill-authoring.integration.test.ts works without bake), package.json pins
 * pnpm via `packageManager`, and ci.yml pins uv for the skills-runtime job.
 * Nothing at build time forces these mirrors to agree, so this test does —
 * it would have caught the devbase pnpm pin silently drifting to 10.27.0
 * while the workspace moved to 11.x.
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

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function extract(source: string, label: string, pattern: RegExp): string {
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`could not extract ${label} (pattern ${pattern})`);
  return match[1];
}

const bake = read("docker-bake.hcl");
const devbase = read("images/devbase/Dockerfile");
const ci = read(".github/workflows/ci.yml");
const rootPkg = JSON.parse(read("package.json")) as { packageManager: string };

function bakeVar(name: string): string {
  return extract(
    bake,
    `bake variable ${name}`,
    new RegExp(`variable\\s+"${name}"\\s*\\{\\s*default\\s*=\\s*"([^"]+)"`),
  );
}

function devbaseArg(name: string): string {
  return extract(devbase, `devbase ARG ${name}`, new RegExp(`^ARG ${name}=(\\S+)`, "m"));
}

const packageManagerPnpm = extract(
  rootPkg.packageManager,
  "package.json packageManager pnpm version",
  /^pnpm@([^+]+)/,
);

// The setup-uv step's pinned version — the one mirror GitHub Actions can't
// read from the HCL variable.
const ciUv = extract(
  ci,
  "ci.yml setup-uv version",
  /astral-sh\/setup-uv[\s\S]*?version:\s*"([^"]+)"/,
);

describe("task-image version pins stay in sync", () => {
  it("uv version: bake == devbase == ci", () => {
    expect(devbaseArg("UV_VERSION")).toBe(bakeVar("UV_VERSION"));
    expect(ciUv).toBe(bakeVar("UV_VERSION"));
  });

  it("uv digest: bake == devbase", () => {
    expect(devbaseArg("UV_DIGEST")).toBe(bakeVar("UV_DIGEST"));
  });

  it("npm version: bake == devbase", () => {
    expect(devbaseArg("NPM_VERSION")).toBe(bakeVar("NPM_VERSION"));
  });

  it("pnpm version: bake == devbase == package.json packageManager", () => {
    expect(devbaseArg("PNPM_VERSION")).toBe(bakeVar("PNPM_VERSION"));
    expect(packageManagerPnpm).toBe(bakeVar("PNPM_VERSION"));
  });

  it("claude-code version: bake == devbase", () => {
    expect(devbaseArg("CLAUDE_CODE_VERSION")).toBe(bakeVar("CLAUDE_CODE_VERSION"));
  });
});
