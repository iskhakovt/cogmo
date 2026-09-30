import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { expectDefined } from "./assertions.js";
import { type BakeTarget, printBakeTarget, withArgDefaults } from "./bake.js";
import { repoRoot } from "./repo-root.js";

/**
 * `docker-bake.hcl` against the files that have to agree with it, as
 * `docker buildx bake --print` resolves it — so inheritance, interpolation and
 * functions count the way they do in a real build.
 *
 * The task images' toolchain pins live in bake alone: their Dockerfiles
 * declare the ARGs without defaults. Two pins have a mirror bake can't feed —
 * package.json pins pnpm via `packageManager`, and ci.yml pins uv for the
 * skills-runtime job — so those are held to the bake values here.
 */

function read(relativePath: string): string {
  return readFileSync(join(repoRoot(), relativePath), "utf8");
}

function extract(source: string, label: string, pattern: RegExp): string {
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`could not extract ${label} (pattern ${pattern})`);
  return match[1];
}

const TASK_TARGETS = ["devbase", "skills"] as const;

const targets = new Map<string, BakeTarget>();

beforeAll(async () => {
  for (const name of [...TASK_TARGETS, "cogmo-e2e"]) {
    targets.set(name, await printBakeTarget(name));
  }
});

function target(name: string): BakeTarget {
  return expectDefined(targets.get(name), `bake target ${name}`);
}

function arg(targetName: string, name: string): string {
  return expectDefined(target(targetName).args[name], `${targetName} arg ${name}`);
}

describe.each(TASK_TARGETS)("the %s Dockerfile takes its toolchain from bake", (name) => {
  it("declares every ARG without a default", () => {
    // A default is a second copy of the pin, which bake overrides and
    // nothing else checks.
    expect(readFileSync(target(name).dockerfilePath, "utf8")).not.toMatch(/^ARG[ \t]+\w+=/m);
  });

  it("is supplied a value for every ARG, and declares every arg bake passes", () => {
    // An ARG bake doesn't pass is empty at build time, and npm installs
    // `latest` for an empty version.
    const dockerfile = readFileSync(target(name).dockerfilePath, "utf8");
    expect(() => withArgDefaults(dockerfile, target(name).args)).not.toThrow();
  });
});

describe("toolchain pins", () => {
  it("devbase and skills run the same uv", () => {
    // Author-side `uv pip compile` in devbase has to produce the lockfile
    // cogmo-skills re-resolves at register time, byte for byte.
    expect(arg("devbase", "UV_VERSION")).toBe(arg("skills", "UV_VERSION"));
    expect(arg("devbase", "UV_DIGEST")).toBe(arg("skills", "UV_DIGEST"));
  });

  it("ci.yml's setup-uv matches bake", () => {
    const ciUv = extract(
      read(".github/workflows/ci.yml"),
      "ci.yml setup-uv version",
      /astral-sh\/setup-uv[\s\S]*?version:\s*"([^"]+)"/,
    );
    expect(ciUv).toBe(arg("skills", "UV_VERSION"));
  });

  it("package.json's packageManager matches bake's pnpm", () => {
    const { packageManager } = JSON.parse(read("package.json")) as { packageManager: string };
    const pnpm = extract(packageManager, "packageManager pnpm version", /^pnpm@([^+]+)/);
    expect(pnpm).toBe(arg("devbase", "PNPM_VERSION"));
  });
});

/**
 * The `cogmo-e2e` target's tag, and the two TypeScript literals that have to
 * name the same image: `e2e-setup.ts` starts a container from whatever bake
 * produced, and `skills.e2e.test.ts` filters containers by image name. All
 * three are only exercised by a local `pnpm test:e2e` — CI sets `E2E_IMAGE` and
 * skips the build — so a rename that splits them surfaces as testcontainers
 * trying to pull `cogmo-e2e:latest` off Docker Hub, not as a red pipeline.
 */
describe("e2e image name", () => {
  function tsImageFallback(relativePath: string): string {
    return extract(
      read(relativePath),
      `E2E image fallback in ${relativePath}`,
      // Either spelling of the fallback: the named constant, or the inline `??`.
      /(?:E2E_IMAGE_FALLBACK = |process\.env\.E2E_IMAGE \?\? )"([^"]+)"/,
    );
  }

  it("bake tag == e2e-setup fallback == skills.e2e filter", () => {
    expect(target("cogmo-e2e").tags).toEqual(["cogmo-e2e:latest"]);
    expect(tsImageFallback("apps/server/test/e2e-setup.ts")).toBe("cogmo-e2e");
    expect(tsImageFallback("apps/server/src/skills/skills.e2e.test.ts")).toBe("cogmo-e2e");
  });
});
