/// <reference path="../../test/vitest.d.ts" />

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Transactor } from "../db/index.js";
import { createTestDatabase } from "../test/pglite.js";
import { LocalDockerSandboxClient } from "./index.js";
import { DrizzleSandboxStore } from "./store/index.js";
import { LABEL_INSTANCE, LABEL_MANAGED, LABEL_ROOT_TASK } from "./supervisor.js";
import type { ResourceLimits } from "./types.js";

// Tiny image with /bin/sleep + sh + echo. Pulled once, cached on the host.
const TEST_IMAGE =
  "mirror.gcr.io/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc";

// `/bin/sh` is dash here, as in the devbase (Ubuntu) and skills (Debian) images.
const DASH_IMAGE =
  "mirror.gcr.io/library/debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a";

// Slice 1 integration runs against runc (no sysbox required on dev machines).
// Sysbox-specific path is exercised in slice 1.0h on GHA ubuntu-24.04.
const RUNTIME = "runc";

const RESOURCE_LIMITS: ResourceLimits = {
  cpus: 0.5,
  memory_bytes: 256 * 1024 * 1024,
  pids: 64,
};

let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleSandboxStore;
let docker: Docker;
let workspaceTmp: string;
const homeVolumes: string[] = [];
const sandboxes: LocalDockerSandboxClient[] = [];
/**
 * Instance ids this test file created — used to scope `afterEach` cleanup
 * so a failing test only deletes containers tagged with one of these
 * instance ids, never containers from other test files running in parallel.
 */
const testFileInstanceIds: string[] = [];

beforeAll(async () => {
  ({ tx, close } = await createTestDatabase());
  store = new DrizzleSandboxStore();
  docker = new Docker();
  workspaceTmp = mkdtempSync(join(tmpdir(), "cogmo-sandbox-it-"));
  writeFileSync(join(workspaceTmp, "marker.txt"), "hello-from-host");

  // Pull alpine if not already present. Skip the test suite with a clear
  // message if Docker isn't reachable.
  try {
    await docker.ping();
  } catch (err) {
    throw new Error(
      `Docker daemon unreachable — sandbox integration tests require Docker. ${(err as Error).message}`,
    );
  }
  for (const image of [TEST_IMAGE, DASH_IMAGE]) {
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
  }
}, 120_000);

afterEach(async () => {
  // Belt-and-suspenders: remove containers tagged with any instance id
  // this test file created. Scoped (not cogmo.managed=true alone) so we
  // never clobber containers created by other integration test files
  // running in parallel.
  for (const instanceId of testFileInstanceIds) {
    const leftover = await docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_MANAGED}=true`, `${LABEL_INSTANCE}=${instanceId}`] },
    });
    for (const c of leftover) {
      await docker
        .getContainer(c.Id)
        .remove({ force: true })
        .catch(() => {});
    }
  }
});

afterAll(async () => {
  for (const s of sandboxes) await s.shutdown();
  for (const v of homeVolumes) {
    await docker
      .getVolume(v)
      .remove({ force: true })
      .catch(() => {});
  }
  rmSync(workspaceTmp, { recursive: true, force: true });
  await close();
});

async function bootSandbox(): Promise<{ sandbox: LocalDockerSandboxClient; instanceId: string }> {
  const inst = await tx((trx) =>
    store.insertInstance(trx, { host: "test-host", pid: process.pid }),
  );
  testFileInstanceIds.push(inst.id);
  const sandbox = await LocalDockerSandboxClient.create({
    docker,
    store,
    runInTx: tx,
    runtime: RUNTIME,
    instanceId: inst.id,
  });
  sandboxes.push(sandbox);
  return { sandbox, instanceId: inst.id };
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readToEnd(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** The `/bin/sh`s the exec wrapper and its kill run under. */
const SHELLS = [
  { sh: "busybox", image: TEST_IMAGE, taskDigit: 1 },
  { sh: "dash", image: DASH_IMAGE, taskDigit: 2 },
] as const;

for (const { sh, image, taskDigit } of SHELLS) {
  describe(`LocalDockerSandboxClient exec teardown (real Docker, runc runtime, ${sh})`, () => {
    type Session = Awaited<ReturnType<LocalDockerSandboxClient["create"]>>;

    async function withSession(n: number, body: (session: Session) => Promise<void>) {
      const { sandbox } = await bootSandbox();
      const taskId = `019d0000-0000-7000-8000-0000000${taskDigit}d1${n}0`;
      const session = await sandbox.create({
        taskId,
        image,
        resourceLimits: RESOURCE_LIMITS,
        expiresAt: new Date(Date.now() + 60_000),
      });
      try {
        await body(session);
      } finally {
        await sandbox.deleteByTaskId(taskId);
      }
    }

    /** How many of the command's two `sleep`s are still running (`ps` is not in every image). */
    async function runningSleeps(session: Session): Promise<number> {
      const listing = await session.exec([
        "sh",
        "-c",
        `for p in /proc/[0-9]*; do tr '\\0' ' ' < "$p/cmdline" 2>/dev/null; echo; done | grep -cE '^sleep 30[01] $' || true`,
      ]);
      return Number(listing.stdout.trim());
    }

    const settleBy = [
      { how: "dispose()", opts: {}, n: 5 },
      { how: "the total deadline", opts: { timeoutMs: 1_500 }, n: 6 },
    ] as const;

    for (const { how, opts, n } of settleBy) {
      it(`stops the command and its children once ${how} settles the exec`, async () => {
        await withSession(n, async (session) => {
          const handle = await session.execStreaming(["sh", "-c", "sleep 300 & sleep 301"], opts);
          await expect.poll(() => runningSleeps(session), { timeout: 5_000 }).toBe(2);

          if (how === "dispose()") await handle.dispose();
          const exited = await handle.exited;
          expect(exited.isErr() && exited.error.kind).toBe(
            how === "dispose()" ? "disposed" : "timed_out",
          );
          // `dispose()` resolves once the teardown has run.
          await handle.dispose();

          expect(await runningSleeps(session)).toBe(0);
        });
      }, 30_000);
    }

    it("keeps the command's exit status and leaves no group file behind", async () => {
      await withSession(7, async (session) => {
        const result = await session.exec(["sh", "-c", "echo out; exit 3"]);
        expect(result).toMatchObject({ stdout: "out\n", exitCode: 3 });
        const left = await session.exec(["sh", "-c", "ls /tmp | grep -c '^cogmo-exec-' || true"]);
        // Only the listing exec's own file, which it removes once it exits.
        expect(left.stdout.trim()).toBe("1");
      });
    }, 30_000);

    it("adds nothing to the command's output when it cannot record its group", async () => {
      await withSession(8, async (session) => {
        await session.exec(["chmod", "0755", "/tmp"]);
        const result = await session.exec(["sh", "-c", "echo out"], { user: "nobody" });
        expect(result).toMatchObject({ stdout: "out\n", stderr: "", exitCode: 0 });
      });
    }, 30_000);
  });
}

describe("LocalDockerSandboxClient (real Docker, runc runtime)", () => {
  it("healthCheck passes when the configured runtime is registered", async () => {
    const { sandbox } = await bootSandbox();
    const result = await sandbox.healthCheck();
    expect(result.ok).toBe(true);
    expect(result.runtime).toBe("runc");
  });

  it("create applies labels, runtime, binds, and resource caps", async () => {
    const { sandbox, instanceId } = await bootSandbox();
    const homeVolume = uniqueName("cogmo-task-home");
    homeVolumes.push(homeVolume);
    const taskId = "019d0000-0000-7000-8000-000000000abc";

    const handle = await sandbox.create({
      taskId,
      worktree: { type: "host-path", hostPath: workspaceTmp },
      homeVolume: { volumeName: homeVolume },
      image: TEST_IMAGE,
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(handle.state.dockerId).toBeTruthy();
    expect(handle.state.containerRowId).toBeTruthy();

    // Daemon-side verification.
    const inspected = await docker.getContainer(handle.state.dockerId).inspect();
    expect(inspected.State.Status).toBe("running");
    expect(inspected.Config.Labels?.[LABEL_MANAGED]).toBe("true");
    expect(inspected.Config.Labels?.[LABEL_INSTANCE]).toBe(instanceId);
    expect(inspected.Config.Labels?.[LABEL_ROOT_TASK]).toBe(taskId);
    expect(inspected.HostConfig.Runtime).toBe("runc");
    expect(inspected.HostConfig.Binds).toContain(`${workspaceTmp}:/workspace`);
    expect(inspected.HostConfig.NanoCpus).toBe(500_000_000);
    expect(inspected.HostConfig.Memory).toBe(256 * 1024 * 1024);
    expect(inspected.HostConfig.PidsLimit).toBe(64);

    // Cogmo-side verification.
    const row = await tx((trx) => store.getContainerByDockerId(trx, handle.state.dockerId));
    expect(row?.status).toBe("running");
    expect(row?.startedAt).toBeInstanceOf(Date);

    await sandbox.deleteByTaskId(taskId);
  });

  it("exec runs a command and reports exit code + stdout", async () => {
    const { sandbox } = await bootSandbox();
    const homeVolume = uniqueName("cogmo-task-home");
    homeVolumes.push(homeVolume);
    const taskId = "019d0000-0000-7000-8000-00000000bbbb";

    const handle = await sandbox.create({
      taskId,
      worktree: { type: "host-path", hostPath: workspaceTmp },
      homeVolume: { volumeName: homeVolume },
      image: TEST_IMAGE,
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
    });

    // The bind mount is visible from inside.
    const exec = await handle.execStreaming(["cat", "/workspace/marker.txt"]);
    const out = await readToEnd(exec.stdout);
    const result = await exec.wait();
    expect(out.trim()).toBe("hello-from-host");
    expect(result.exitCode).toBe(0);

    await sandbox.deleteByTaskId(taskId);
  });

  it("exec demultiplexes stdout and stderr separately", async () => {
    const { sandbox } = await bootSandbox();
    const homeVolume = uniqueName("cogmo-task-home");
    homeVolumes.push(homeVolume);
    const taskId = "019d0000-0000-7000-8000-00000000cccc";

    const handle = await sandbox.create({
      taskId,
      worktree: { type: "host-path", hostPath: workspaceTmp },
      homeVolume: { volumeName: homeVolume },
      image: TEST_IMAGE,
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const exec = await handle.execStreaming(["sh", "-c", "echo to-out; echo to-err >&2; exit 7"]);
    const [out, err] = await Promise.all([readToEnd(exec.stdout), readToEnd(exec.stderr)]);
    const result = await exec.wait();
    expect(out.trim()).toBe("to-out");
    expect(err.trim()).toBe("to-err");
    expect(result.exitCode).toBe(7);

    await sandbox.deleteByTaskId(taskId);
  });

  it("deleteByTaskId removes the container and marks the row reaped", async () => {
    const { sandbox } = await bootSandbox();
    const homeVolume = uniqueName("cogmo-task-home");
    homeVolumes.push(homeVolume);
    const taskId = "019d0000-0000-7000-8000-00000000dddd";

    const handle = await sandbox.create({
      taskId,
      worktree: { type: "host-path", hostPath: workspaceTmp },
      homeVolume: { volumeName: homeVolume },
      image: TEST_IMAGE,
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await sandbox.deleteByTaskId(taskId);

    await expect(docker.getContainer(handle.state.dockerId).inspect()).rejects.toThrow();
    const row = await tx((trx) => store.getContainerByDockerId(trx, handle.state.dockerId));
    expect(row?.status).toBe("reaped");
  });

  it("deleteByTaskId is idempotent — second call is a no-op", async () => {
    const { sandbox } = await bootSandbox();
    const homeVolume = uniqueName("cogmo-task-home");
    homeVolumes.push(homeVolume);
    const taskId = "019d0000-0000-7000-8000-00000000eeee";

    await sandbox.create({
      taskId,
      worktree: { type: "host-path", hostPath: workspaceTmp },
      homeVolume: { volumeName: homeVolume },
      image: TEST_IMAGE,
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await sandbox.deleteByTaskId(taskId);
    await expect(sandbox.deleteByTaskId(taskId)).resolves.toBeUndefined();
  });

  it("reconcileCrashedInstances reaps containers labelled with a stale instance id", async () => {
    // Stale instance leaves `stopped_at` NULL (the crash signature). Current
    // instance reaps it via `listLiveInstances`.
    const { sandbox: stale } = await bootSandbox();
    const homeVolume = uniqueName("cogmo-task-home");
    homeVolumes.push(homeVolume);
    const taskId = "019d0000-0000-7000-8000-00000000ffff";

    const handle = await stale.create({
      taskId,
      worktree: { type: "host-path", hostPath: workspaceTmp },
      homeVolume: { volumeName: homeVolume },
      image: TEST_IMAGE,
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const { sandbox: current, instanceId: currentId } = await bootSandbox();
    const result = await current.reconcileCrashedInstances(currentId);
    expect(result.orphansReaped).toBeGreaterThanOrEqual(1);

    await expect(docker.getContainer(handle.state.dockerId).inspect()).rejects.toThrow();
    const row = await tx((trx) => store.getContainerByDockerId(trx, handle.state.dockerId));
    expect(row?.status).toBe("reaped");
  });

  it("inspect (via daemon) returns runtime + status", async () => {
    const { sandbox } = await bootSandbox();
    const homeVolume = uniqueName("cogmo-task-home");
    homeVolumes.push(homeVolume);
    const taskId = "019d0000-0000-7000-8000-000000001111";

    const handle = await sandbox.create({
      taskId,
      worktree: { type: "host-path", hostPath: workspaceTmp },
      homeVolume: { volumeName: homeVolume },
      image: TEST_IMAGE,
      resourceLimits: RESOURCE_LIMITS,
      expiresAt: new Date(Date.now() + 60_000),
    });
    // inspectContainer was removed from the public interface; verify
    // the underlying state by querying the Docker daemon directly.
    const inspected = await docker.getContainer(handle.state.dockerId).inspect();
    expect(inspected.HostConfig.Runtime).toBe("runc");
    expect(["running", "created"]).toContain(inspected.State.Status);
    await sandbox.deleteByTaskId(taskId);
  });
});
