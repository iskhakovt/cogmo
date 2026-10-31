import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { expectDefined } from "./assertions.js";
import { repoRoot } from "./repo-root.js";

/**
 * pnpm re-checks every lockfile entry against `minimumReleaseAge` on install,
 * so a Dependabot version update that waited less than that opens a PR whose
 * frozen install fails. The two are one soak, written in two places.
 */

const WorkspaceSchema = z.object({ minimumReleaseAge: z.number() });

const DependabotSchema = z.object({
  updates: z.array(
    z.object({
      "package-ecosystem": z.string(),
      // Strict: a `semver-*-days`, `include` or `exclude` key would let
      // Dependabot open PRs on releases younger than the soak.
      cooldown: z.object({ "default-days": z.number() }).strict().optional(),
    }),
  ),
});

function readYaml(relativePath: string): unknown {
  return parseYaml(readFileSync(join(repoRoot(), relativePath), "utf8"));
}

describe("release-age soak", () => {
  it("pnpm's minimumReleaseAge is Dependabot's npm cooldown", () => {
    const { minimumReleaseAge } = WorkspaceSchema.parse(readYaml("pnpm-workspace.yaml"));
    const npm = expectDefined(
      DependabotSchema.parse(readYaml(".github/dependabot.yml")).updates.find(
        (update) => update["package-ecosystem"] === "npm",
      ),
      "npm entry in dependabot.yml",
    );
    const cooldownDays = expectDefined(npm.cooldown, "npm cooldown")["default-days"];

    expect(minimumReleaseAge).toBe(cooldownDays * 24 * 60);
  });
});
