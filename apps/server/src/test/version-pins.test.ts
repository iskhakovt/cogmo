import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as R from "remeda";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./repo-root.js";

/**
 * Image pins the test harnesses share. Pins that bake resolves are held to it
 * by `docker-bake.integration.test.ts`.
 */

const SERVER_DIRS = ["dev", "scripts", "src", "test"] as const;
const INNGEST_IMAGE = /mirror\.gcr\.io\/inngest\/inngest:/;

function serverTsFiles(): ReadonlyArray<string> {
  const server = join(repoRoot(), "apps/server");
  return R.flatMap(SERVER_DIRS, (dir) =>
    readdirSync(join(server, dir), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join("apps/server", dir, f)),
  );
}

describe("inngest image has one home", () => {
  // The boot-check integration test's premises hold only for the image the
  // harnesses run, so both take it from `dev/containers.ts`.
  it("only dev/containers.ts pins it", () => {
    const pinned = serverTsFiles().filter((f) =>
      INNGEST_IMAGE.test(readFileSync(join(repoRoot(), f), "utf8")),
    );

    expect(pinned).toEqual(["apps/server/dev/containers.ts"]);
  });
});

describe("the skills runtime's Python minor", () => {
  // `.python-version` is the minor CI's skills-runtime job tests; the skills
  // image's FROM is the one it runs. A Dependabot bump of the FROM alone fails
  // here rather than only in the image build.
  it("is a bare minor in .python-version that every python FROM in the skills image runs", () => {
    const minor = readFileSync(join(repoRoot(), "images/skills/.python-version"), "utf8").trim();
    const dockerfile = readFileSync(join(repoRoot(), "images/skills/Dockerfile"), "utf8");
    const fromMinors = Array.from(
      dockerfile.matchAll(/^FROM\s+(?:--\S+\s+)*(?:\S*\/)?python:(\d+\.\d+)\b/gm),
      (match) => match[1],
    );

    expect(minor).toMatch(/^\d+\.\d+$/);
    expect(fromMinors.length).toBeGreaterThan(0);
    expect(fromMinors.filter((m) => m !== minor)).toEqual([]);
  });
});
