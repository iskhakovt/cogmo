import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./repo-root.js";

/**
 * Image pins repeated across test harnesses. Pins that bake resolves are held
 * to it by `docker-bake.integration.test.ts`.
 */

function inngestImage(relativePath: string): string {
  const source = readFileSync(join(repoRoot(), relativePath), "utf8");
  const match = source.match(/"(mirror\.gcr\.io\/inngest\/inngest:[^"]+)"/);
  if (!match?.[1]) throw new Error(`could not extract the inngest image in ${relativePath}`);
  return match[1];
}

describe("inngest image stays in sync", () => {
  // The boot-check integration test's premises hold only for the image the harnesses run.
  it("dev/containers.ts == checks.integration.test.ts", () => {
    expect(inngestImage("apps/server/src/boot/checks.integration.test.ts")).toBe(
      inngestImage("apps/server/dev/containers.ts"),
    );
  });
});
