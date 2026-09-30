import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withArgDefaults } from "./bake.js";
import { repoRoot } from "./repo-root.js";

/**
 * Cross-file version-pin consistency guard.
 *
 * `docker-bake.hcl` is the only copy of the task images' toolchain pins: the
 * Dockerfiles declare their ARGs without defaults. Two pins still have a
 * mirror bake can't feed — package.json pins pnpm via `packageManager`, and
 * ci.yml pins uv for the skills-runtime job — so this test holds those to
 * the bake values, and holds the Dockerfiles to taking every ARG from bake.
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
const ci = read(".github/workflows/ci.yml");
const rootPkg = JSON.parse(read("package.json")) as { packageManager: string };

function bakeVar(name: string): string {
  return extract(
    bake,
    `bake variable ${name}`,
    new RegExp(`variable\\s+"${name}"\\s*\\{\\s*default\\s*=\\s*"([^"]+)"`),
  );
}

/**
 * A bake target's `args`, with each `${VAR}` resolved to the variable's
 * default. Only the target's own block is read — none of the task targets
 * inherit args.
 */
function bakeTargetArgs(target: string): Record<string, string> {
  const block = extract(
    bake,
    `bake target ${target}`,
    new RegExp(`^target\\s+"${target}"\\s*\\{([\\s\\S]*?)^\\}`, "m"),
  );
  const args = extract(block, `bake target ${target} args`, /args\s*=\s*\{([\s\S]*?)^\s*\}/m);
  return Object.fromEntries(
    [...args.matchAll(/^\s*(\w+)\s*=\s*"([^"]*)"/gm)].flatMap(([, name, value]) =>
      name === undefined || value === undefined
        ? []
        : [[name, value.replace(/\$\{(\w+)\}/g, (_, variable: string) => bakeVar(variable))]],
    ),
  );
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
  it("uv version: bake == ci", () => {
    expect(ciUv).toBe(bakeVar("UV_VERSION"));
  });

  it("pnpm version: bake == package.json packageManager", () => {
    expect(packageManagerPnpm).toBe(bakeVar("PNPM_VERSION"));
  });
});

describe.each([
  ["devbase", "images/devbase/Dockerfile"],
  ["skills", "images/skills/Dockerfile"],
])("the %s Dockerfile takes its toolchain from bake", (target, dockerfilePath) => {
  const dockerfile = read(dockerfilePath);

  it("declares every ARG without a default", () => {
    // A default is a second copy of the pin, which bake overrides and
    // nothing else checks.
    expect(dockerfile).not.toMatch(/^ARG[ \t]+\w+=/m);
  });

  it("is supplied a value for every ARG, and declares every arg bake passes", () => {
    // An ARG bake doesn't pass is empty at build time, and npm installs
    // `latest` for an empty version.
    expect(() => withArgDefaults(dockerfile, bakeTargetArgs(target))).not.toThrow();
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
  // The boot-check integration test's premises hold only for the image the harnesses run.
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
