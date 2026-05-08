/**
 * Upload the per-task askpass bundle into a freshly-created Daytona
 * sandbox. Mirrors the host-side layout `provisionAskpass` writes
 * (`src/sandbox/askpass.ts`) so the in-container view (helper / pat /
 * signing-key / signing-key.pub at `/.cogmo-askpass/`) is identical to
 * what Local-Docker delivers via bind mount — `runCommitAndPush` and
 * the `GIT_ASKPASS` helper need no awareness of which transport got
 * the files there.
 *
 * Permissions matter: `ssh-keygen -Y sign` refuses to load a private
 * key file with a mode broader than 0o600, and the helper has to be
 * executable. `fs.setFilePermissions` is best-effort across SDK
 * versions (some return-shapes silently no-op); when in doubt, the
 * upload itself is the contract — perms can be re-applied via `chmod`
 * inside the sandbox at first use.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sandbox as DaytonaSdkSandbox } from "@daytonaio/sdk";

const ASKPASS_FILES = [
  { name: "helper", mode: "755" },
  { name: "pat", mode: "644" },
  { name: "signing-key", mode: "600" },
  { name: "signing-key.pub", mode: "644" },
] as const;

/**
 * Read the four askpass files from `hostDir` and upload them to
 * `containerDir` inside the sandbox, applying the same modes
 * `provisionAskpass` set on the host.
 */
export async function uploadAskpassToSandbox(args: {
  sandbox: DaytonaSdkSandbox;
  hostDir: string;
  containerDir: string;
}): Promise<void> {
  const { sandbox, hostDir, containerDir } = args;

  const uploads = ASKPASS_FILES.map(({ name }) => ({
    source: readFileSync(join(hostDir, name)),
    destination: join(containerDir, name),
  }));

  await sandbox.fs.uploadFiles(uploads);

  for (const { name, mode } of ASKPASS_FILES) {
    await sandbox.fs.setFilePermissions(join(containerDir, name), { mode });
  }
}
