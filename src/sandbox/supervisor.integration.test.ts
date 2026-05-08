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
  const stream = await docker.pull(TEST_IMAGE);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
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
    // Boot two sandboxes — one "stale" (creates a container, walks away),
    // one "current" (reconciles and should reap the stale one's container).
    const { sandbox: stale, instanceId: staleId } = await bootSandbox();
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
    await tx((trx) => store.closeInstance(trx, staleId));

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
