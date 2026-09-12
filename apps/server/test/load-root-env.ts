import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { repoRoot } from "../src/test/repo-root.js";

const ROOT_ENV = join(repoRoot(), ".env");

/** Load the repo-root .env for record mode — no-op when it's absent (e.g. CI). */
export function loadRootEnv(): void {
  if (existsSync(ROOT_ENV)) loadEnvFile(ROOT_ENV);
}
