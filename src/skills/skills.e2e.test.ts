/// <reference path="../../test/vitest.d.ts" />

/**
 * E2e validation for the skills module against the production Docker
 * artifact. Two key questions only this tier can answer:
 *
 *   1. Does Pyodide load inside the production image? If Pyodide's WASM
 *      bootstrap depends on something the base image doesn't ship, every
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
 * Find the running app container by image ancestor. Image name comes from the
 * same `E2E_IMAGE` env var the e2e setup uses (CI: `cogmo:ci`, local default:
 * `cogmo-e2e`) — testcontainers picks a random container name, so filter by
 * the image instead.
 */
async function findAppContainer(): Promise<string> {
  const imageName = process.env.E2E_IMAGE ?? "cogmo-e2e";
  const { stdout } = await execFile("docker", [
    "ps",
    "--filter",
    `ancestor=${imageName}`,
    "--format",
    "{{.ID}}",
  ]);
  const id = stdout.trim().split("\n")[0];
  if (!id) {
    throw new Error(`no container found via 'docker ps --filter ancestor=${imageName}'`);
  }
  return id;
}

async function dockerExec(args: readonly string[]): Promise<DockerExec> {
  const containerId = await findAppContainer();
  // Don't swallow `docker exec` failures — non-zero exit codes signal real
  // container-side errors that should fail the test loudly. Tests that
  // exercise an in-container failure path can `await expect(...).rejects.…`.
  const { stdout, stderr } = await execFile("docker", ["exec", containerId, ...args]);
  return { stdout, stderr };
}

describe("skills e2e (production Docker image)", { timeout: 120_000 }, () => {
  it("the production Dockerfile creates /var/lib/cogmo/skills owned by the node user", async () => {
    const r = await dockerExec([
      "node",
      "-e",
      'const fs=require("fs");const s=fs.statSync("/var/lib/cogmo/skills");process.stdout.write(JSON.stringify({uid:s.uid,gid:s.gid,mode:s.mode&0o777}))',
    ]);
    expect(r.stdout).toContain('"uid":1000');
    expect(r.stdout).toContain('"gid":1000');
  });

  it("bootstrap initialized the bare skills repo at the default path", async () => {
    // `bootstrap()` ran when the container started in serve mode; HEAD must exist.
    const r = await dockerExec([
      "node",
      "-e",
      'process.stdout.write(String(require("fs").existsSync("/var/lib/cogmo/skills/HEAD")))',
    ]);
    expect(r.stdout.trim()).toBe("true");
  });

  it("the pre-receive hook is installed with mode 0755", async () => {
    const r = await dockerExec([
      "node",
      "-e",
      'const fs=require("fs");const s=fs.statSync("/var/lib/cogmo/skills/hooks/pre-receive");process.stdout.write(JSON.stringify({mode:s.mode&0o777,size:s.size}))',
    ]);
    const meta = JSON.parse(r.stdout);
    expect(meta.mode).toBe(0o755);
    expect(meta.size).toBeGreaterThan(0);
  });

  it("dist/skills/worker-wasm/worker-entry.js was bundled by tsup", async () => {
    const r = await dockerExec([
      "node",
      "-e",
      'process.stdout.write(String(require("fs").existsSync("/app/dist/skills/worker-wasm/worker-entry.js")))',
    ]);
    expect(r.stdout.trim()).toBe("true");
  });

  it("Pyodide loads inside the production image", async () => {
    // Spin up Pyodide directly inside the container via dynamic import. This
    // is the load-bearing assertion: if WASM init or libc deps fail in the
    // base image, this throws or hangs and the test times out.
    const r = await dockerExec([
      "node",
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
