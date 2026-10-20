/// <reference path="../../test/vitest.d.ts" />

/**
 * E2e validation for the skills module against the production Docker
 * artifact. Two key questions only this tier can answer:
 *
 *   1. Does Pyodide load inside the production image? If Pyodide's WASM
 *      bootstrap depends on something the base image doesn't ship, every
 *      skill invocation in production crashes.
 *
 *   2. Does a tier-1 skill run from the bundled build? `host.ts` spawns its
 *      worker from `new URL("./worker-entry.js", import.meta.url)`, which
 *      resolves only if tsup emits the worker entry beside the bundle the
 *      host landed in. Source-tier tests load the host from `src/` and never
 *      take that path; registering and running a skill through the shipped
 *      CLI does.
 *
 * The app container boots in `serve` mode (per the e2e setup), so we drive
 * the skills surface via `docker exec` invoking `node dist/main.js skills …`.
 */

import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const execFile = promisify(execFileCb);

interface DockerExec {
  stdout: string;
  stderr: string;
}

interface CliRun extends DockerExec {
  /** `null` when the process ended on a signal. */
  code: number | null;
}

/** The bare skills repo the image creates and `bootstrap()` initializes. */
const SKILLS_REPO = "/var/lib/cogmo/skills";

const ECHO_SKILL = "e2e-echo";

const ECHO_MANIFEST = `---
name: ${ECHO_SKILL}
description: e2e tier-1 echo skill
tier: wasm
inputs:
  type: object
  properties:
    x:
      type: integer
  required:
    - x
---
`;

const ECHO_BODY = `
async def run(inputs, ctx):
    return {"echo": inputs["x"] + 1}
`;

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

/**
 * Run the shipped CLI in the app container, with the image ENTRYPOINT's
 * command line (a worker thread inherits its `execArgv`). Settles with the
 * exit code instead of rejecting on a nonzero one: the CLI prints a failed
 * command's result on stdout, and that is what an assertion needs to show.
 * `LOG_LEVEL=fatal` keeps the logger, which also writes to stdout, out of it.
 */
async function runCogmo(args: readonly string[]): Promise<CliRun> {
  const containerId = await findAppContainer();
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", [
      "exec",
      "--env",
      "LOG_LEVEL=fatal",
      containerId,
      "node",
      "--import",
      "./dist/otel.js",
      "dist/main.js",
      ...args,
    ]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** The run's exit code and the JSON it printed, as one value to assert on. */
function cliOutcome(run: CliRun): { code: number | null; output: unknown } {
  try {
    return { code: run.code, output: JSON.parse(run.stdout) };
  } catch (e) {
    throw new Error(
      `expected JSON on stdout (exit ${run.code})\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
      { cause: e },
    );
  }
}

/**
 * Commit `SKILL.md` + `skill.py` in a scratch clone of the skills repo inside
 * the container, on top of `main` if it exists, and push the commit to
 * `branch` for `skills register` to deploy. Returns the pushed sha.
 */
async function pushSkillBranch(branch: string, manifest: string, body: string): Promise<string> {
  const work = (await dockerExec(["mktemp", "-d"])).stdout.trim();
  const git = (...args: string[]) => dockerExec(["git", "-C", work, ...args]);
  const write = (file: string, content: string) =>
    dockerExec([
      "node",
      "-e",
      "require('fs').writeFileSync(process.argv[1], process.argv[2])",
      `${work}/${file}`,
      content,
    ]);
  try {
    await dockerExec(["git", "clone", "--quiet", SKILLS_REPO, work]);
    await write("SKILL.md", manifest);
    await write("skill.py", body);
    await git("add", "SKILL.md", "skill.py");
    await git(
      "-c",
      "user.name=cogmo-e2e",
      "-c",
      "user.email=e2e@cogmo.invalid",
      "commit",
      "--quiet",
      "--message",
      `add ${branch}`,
    );
    const sha = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    return sha;
  } finally {
    await dockerExec(["rm", "-rf", work]);
  }
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
    const meta = z.object({ mode: z.number(), size: z.number() }).parse(JSON.parse(r.stdout));
    expect(meta.mode).toBe(0o755);
    expect(meta.size).toBeGreaterThan(0);
  });

  it("a tier-1 skill registered through the shipped CLI runs on a Pyodide worker", async () => {
    // Separate processes, as in production: `run` reads the source `register`
    // put live back out of the bare repo, then spawns the worker from the
    // bundled host.
    const branch = `skill/${ECHO_SKILL}`;
    const sha = await pushSkillBranch(branch, ECHO_MANIFEST, ECHO_BODY);

    const registered = await runCogmo(["skills", "register", branch]);
    expect(cliOutcome(registered)).toEqual({
      code: 0,
      output: { name: ECHO_SKILL, riskTier: expect.any(String), gitSha: sha, status: "live" },
    });

    const ran = await runCogmo(["skills", "run", ECHO_SKILL, JSON.stringify({ x: 7 })]);
    expect(cliOutcome(ran)).toEqual({
      code: 0,
      output: { runId: expect.any(String), status: "success", output: { echo: 8 } },
    });
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
