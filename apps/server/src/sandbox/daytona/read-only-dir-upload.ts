/**
 * Upload a session's read-only directory (`SessionSpec.readOnlyDir`) into a
 * Daytona sandbox, which has no host bind to give it one.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sandbox as DaytonaSdkSandbox } from "@daytona/sdk";
import type { ReadOnlyDirSpec } from "../index.js";

/**
 * Upload each regular file directly in `hostDir` to `containerDir`, in one
 * `fs.uploadFiles` call, over whatever an earlier upload left there. It sets
 * no mode: the session only reads them. Rejects when a file cannot be read or
 * the upload fails, which can leave some of the files written.
 */
export async function uploadReadOnlyDir(args: {
  sandbox: DaytonaSdkSandbox;
  dir: ReadOnlyDirSpec;
}): Promise<void> {
  const { sandbox, dir } = args;
  const entries = await readdir(dir.hostDir, { withFileTypes: true });
  const uploads = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => ({
        source: await readFile(join(dir.hostDir, entry.name)),
        destination: join(dir.containerDir, entry.name),
      })),
  );
  await sandbox.fs.uploadFiles(uploads);
}
