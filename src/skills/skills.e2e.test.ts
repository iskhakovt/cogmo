/// <reference path="../../test/vitest.d.ts" />

/**
 * E2e validation for the skills module against the production Docker
 * artifact. Two key questions only this tier can answer:
 *
 *   1. Does Pyodide load inside `gcr.io/distroless/nodejs24-debian13`? The
 *      base image lacks a shell and most libc affordances; if Pyodide's
 *      WASM bootstrap depends on something distroless doesn't ship, every
 *      skill invocation in production crashes.
 *
 *   2. Does `host.ts`'s `import.meta.url`-relative resolution find the
 *      bundled `worker-entry.js` correctly post-tsup-build? Production
 *      uses the `worker-entry.js` sibling path; this is the only test that
 *      catches a regression in the build emitting it elsewhere.
 *
 * The app container boots in `serve` mode (per the e2e setup), so we drive
 * the skills surface via `docker exec` invoking `node dist/main.js skills …`.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCb);

interface DockerExec {
  stdout: string;
  stderr: string;
}

/**
 * Find the running app container by image label. Avoids hard-coding the
 * container name (testcontainers picks a random one).
 */
async function findAppContainer(): Promise<string> {
  const { stdout } = await execFile("docker", [
    "ps",
    "--filter",
    "ancestor=cogmo-e2e",
    "--format",
    "{{.ID}}",
  ]);
  const id = stdout.trim().split("\n")[0];
  if (!id) throw new Error("no cogmo-e2e container found via `docker ps`");
  return id;
}

async function dockerExec(args: readonly string[]): Promise<DockerExec> {
  const containerId = await findAppContainer();
  try {
    const { stdout, stderr } = await execFile("docker", ["exec", containerId, ...args]);
    return { stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("skills e2e (production Docker image)", { timeout: 120_000 }, () => {
  it("the production Dockerfile creates /var/lib/cogmo/skills with nonroot ownership", async () => {
    // distroless has no shell, but `node` can stat files. Use the runtime
    // node binary that's present in the image (PID 1 is node).
    const r = await dockerExec([
      "/nodejs/bin/node",
      "-e",
      'const fs=require("fs");const s=fs.statSync("/var/lib/cogmo/skills");process.stdout.write(JSON.stringify({uid:s.uid,gid:s.gid,mode:s.mode&0o777}))',
    ]);
    expect(r.stdout).toContain('"uid":65532');
    expect(r.stdout).toContain('"gid":65532');
  });

  it("bootstrap initialized the bare skills repo at the default path", async () => {
    // `bootstrap()` ran when the container started in serve mode; HEAD must exist.
    const r = await dockerExec([
      "/nodejs/bin/node",
      "-e",
      'process.stdout.write(String(require("fs").existsSync("/var/lib/cogmo/skills/HEAD")))',
    ]);
    expect(r.stdout.trim()).toBe("true");
  });

  it("the pre-receive hook is installed with mode 0755", async () => {
    const r = await dockerExec([
      "/nodejs/bin/node",
      "-e",
      'const fs=require("fs");const s=fs.statSync("/var/lib/cogmo/skills/hooks/pre-receive");process.stdout.write(JSON.stringify({mode:s.mode&0o777,size:s.size}))',
    ]);
    const meta = JSON.parse(r.stdout);
    expect(meta.mode).toBe(0o755);
    expect(meta.size).toBeGreaterThan(0);
  });

  it("dist/skills/worker-wasm/worker-entry.js was bundled by tsup", async () => {
    const r = await dockerExec([
      "/nodejs/bin/node",
      "-e",
      'process.stdout.write(String(require("fs").existsSync("/app/dist/skills/worker-wasm/worker-entry.js")))',
    ]);
    expect(r.stdout.trim()).toBe("true");
  });

  it("Pyodide loads inside distroless", async () => {
    // Spin up Pyodide directly inside the container via dynamic import. This
    // is the load-bearing assertion: if WASM init or libc deps fail in
    // distroless, this throws or hangs and the test times out.
    const r = await dockerExec([
      "/nodejs/bin/node",
      "--input-type=module",
      "-e",
      `
        const { loadPyodide } = await import("/app/node_modules/pyodide/pyodide.mjs");
        const py = await loadPyodide();
        const v = py.runPython("1 + 2");
        process.stdout.write(String(v));
      `,
    ]);
    expect(r.stdout.trim()).toBe("3");
  });
});
