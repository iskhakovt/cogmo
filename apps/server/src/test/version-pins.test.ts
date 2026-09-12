import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./repo-root.js";

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

/**
 * The `cogmo-e2e` bake target's tag, and the two TypeScript literals that have
 * to name the same image: `e2e-setup.ts` starts a container from whatever bake
 * produced, and `skills.e2e.test.ts` filters containers by image name. All
 * three are only exercised by a local `pnpm test:e2e` — CI sets `E2E_IMAGE`
 * and skips the build — so a rename that splits them surfaces as testcontainers
 * trying to pull `cogmo-e2e:latest` off Docker Hub, not as a red pipeline.
 */
const bakeE2eTag = extract(
  bake,
  "bake cogmo-e2e tag",
  /target\s+"cogmo-e2e"\s*\{[\s\S]*?tags\s*=\s*\["([^"]+)"\]/,
);

function tsImageFallback(relativePath: string): string {
  return extract(
    read(relativePath),
    `E2E image fallback in ${relativePath}`,
    // Either spelling of the fallback: the named constant, or the inline `??`.
    /(?:E2E_IMAGE_FALLBACK = |process\.env\.E2E_IMAGE \?\? )"([^"]+)"/,
  );
}

function inngestImage(relativePath: string): string {
  return extract(
    read(relativePath),
    `inngest image in ${relativePath}`,
    /"(mirror\.gcr\.io\/inngest\/inngest:[^"]+)"/,
  );
}

describe("inngest image stays in sync", () => {
  // The boot-check integration test pins what a keyed server enforces; it
  // proves nothing about an image the dev and test harnesses no longer run.
  it("dev/containers.ts == checks.integration.test.ts", () => {
    expect(inngestImage("apps/server/src/boot/checks.integration.test.ts")).toBe(
      inngestImage("apps/server/dev/containers.ts"),
    );
  });
});

describe("e2e image name stays in sync", () => {
  it("bake tag == e2e-setup fallback == skills.e2e filter", () => {
    expect(bakeE2eTag).toBe("cogmo-e2e:latest");
    const [repository] = bakeE2eTag.split(":");
    expect(tsImageFallback("apps/server/test/e2e-setup.ts")).toBe(repository);
    expect(tsImageFallback("apps/server/src/skills/skills.e2e.test.ts")).toBe(repository);
  });
});
