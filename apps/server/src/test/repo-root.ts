import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to the repo root, found by walking up from this file to the
 * directory holding `pnpm-workspace.yaml`.
 *
 * Vitest runs with the cwd set to the package that owns the config —
 * `apps/server` — while the workspace manifests, the `.env` and the runtime
 * image's `Dockerfile` + `.dockerignore` sit a level above it. A cwd-relative
 * path to any of those names the wrong directory, so callers reaching outside
 * the package take their root from here. Walking to a marker rather than
 * counting `../` also keeps the answer right wherever the caller lives.
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root (pnpm-workspace.yaml) not found");
    dir = parent;
  }
  return dir;
}
