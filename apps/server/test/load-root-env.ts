import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

// Resolve the repo-root .env relative to this file, not the cwd, so RECORD=1
// runs load real upstream keys no matter how vitest is launched.
const ROOT_ENV = fileURLToPath(new URL("../../../.env", import.meta.url));

/** Load the repo-root .env for record mode — no-op when it's absent (e.g. CI). */
export function loadRootEnv(): void {
  if (existsSync(ROOT_ENV)) loadEnvFile(ROOT_ENV);
}
