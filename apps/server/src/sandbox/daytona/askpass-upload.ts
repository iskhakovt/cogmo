/**
 * Upload the per-task askpass bundle into a Daytona sandbox at the same
 * `/tmp/cogmo-askpass/` layout `provisionAskpass` writes on the host, so
 * `runCommitAndPush` and the `GIT_ASKPASS` helper see identical files
 * regardless of transport. Modes match what `ssh-keygen -Y sign` and
 * the helper script require — 0o600 on the signing key is the strict
 * one (the rest only matter for execution / readability).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sandbox as DaytonaSdkSandbox } from "@daytona/sdk";

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

  // Independent network calls — fan out and let them race. `allSettled`
  // (rather than `Promise.all`) so a sibling rejection doesn't surface
  // as an unhandled rejection while we wait for the others to land;
  // the caller's rollback runs against a quiesced sandbox instead of
  // chasing in-flight ops.
  const results = await Promise.allSettled(
    ASKPASS_FILES.map(({ name, mode }) =>
      sandbox.fs.setFilePermissions(join(containerDir, name), { mode }),
    ),
  );
  const failure = results.find((r) => r.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
