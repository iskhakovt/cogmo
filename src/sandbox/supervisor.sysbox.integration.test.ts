/// <reference path="../../test/vitest.d.ts" />

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../db/index.js";
import { createTestDatabase } from "../test/pglite.js";
import { LocalInProcessSandbox } from "./index.js";
import { DrizzleSandboxStore } from "./store/index.js";
import { LABEL_INSTANCE, LABEL_MANAGED } from "./supervisor.js";
import type { ResourceLimits } from "./types.js";

/**
 * Sysbox-runtime e2e — proves the supervisor actually creates `sysbox-runc`
 * containers in an environment where sysbox is registered, and that the
 * runtime delivers its core promise (userns isolation: container root maps
 * to a non-root host uid).
 *
 * Gated by SANDBOX_RUNTIME=sysbox env. Skipped on dev machines that don't
 * have sysbox installed; runs in the GHA `sysbox-e2e` job which installs
 * sysbox 0.7.0 via .deb on `ubuntu-24.04`. The runc-flavoured supervisor
 * tests in `supervisor.integration.test.ts` cover the rest of the lifecycle.
 */

const SHOULD_RUN = process.env.SANDBOX_RUNTIME === "sysbox";
const TEST_IMAGE = "mirror.gcr.io/library/alpine:3.20";
const RESOURCE_LIMITS: ResourceLimits = {
  cpus: 0.5,
  memory_bytes: 256 * 1024 * 1024,
  pids: 64,
};

let db: Database;
let close: () => Promise<void>;
let store: DrizzleSandboxStore;
let docker: Docker;
let workspaceTmp: string;
const sandboxes: LocalInProcessSandbox[] = [];
const homeVolumes: string[] = [];

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  ({ db, close } = await createTestDatabase());
  store = new DrizzleSandboxStore(db);
  docker = new Docker();
  workspaceTmp = mkdtempSync(join(tmpdir(), "cogmo-sysbox-it-"));

  const stream = await docker.pull(TEST_IMAGE);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
}, 120_000);

afterAll(async () => {
  if (!SHOULD_RUN) return;
  for (const s of sandboxes) await s.shutdown();
  // Belt-and-suspenders cleanup.
  const leftover = await docker.listContainers({
    all: true,
    filters: { label: [`${LABEL_MANAGED}=true`] },
  });
  for (const c of leftover) {
    await docker
      .getContainer(c.Id)
      .remove({ force: true })
      .catch(() => {});
  }
  for (const v of homeVolumes) {
    await docker
      .getVolume(v)
      .remove({ force: true })
      .catch(() => {});
  }
  rmSync(workspaceTmp, { recursive: true, force: true });
  await close();
});

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe.skipIf(!SHOULD_RUN)("LocalInProcessSandbox (sysbox runtime, GHA only)", () => {
  it("creates a sysbox-runc container and inspects with the right runtime", async () => {
    const inst = await store.insertInstance({ host: "test-host", pid: process.pid });
    const sandbox = await LocalInProcessSandbox.create({
      docker,
      store,
      runtime: "sysbox",
      instanceId: inst.id,
    });
    sandboxes.push(sandbox);

    const homeVolume = uniqueName("cogmo-task-home");
    homeVolumes.push(homeVolume);
    const taskId = "019d0000-0000-7000-8000-0000000000aa";

    const handle = await sandbox.createTaskContainer({
      rootTaskId: taskId,
      worktreePath: workspaceTmp,
      homeVolumeName: homeVolume,
      image: TEST_IMAGE,
      resourceLimits: RESOURCE_LIMITS,
      ttl: { expiresAt: new Date(Date.now() + 60_000) },
      allowPrivilegedRunc: false,
    });

    const inspected = await docker.getContainer(handle.dockerId).inspect();
    expect(inspected.HostConfig.Runtime).toBe("sysbox-runc");
    expect(inspected.Config.Labels?.[LABEL_INSTANCE]).toBe(inst.id);

    await sandbox.stopTask(taskId);
  });

  it("delivers userns isolation — container root maps to a non-root host uid", async () => {
    // Sysbox's defining property: the container sees uid 0 inside, but on
    // the host it's a remapped uid (typically 100000+ from a sysbox-managed
    // subuid range). We verify by running `id -u` inside (returns 0) and
    // separately reading the rootfs ownership from the host (would be uid 0
    // under runc, remapped under sysbox).
    const inst = await store.insertInstance({ host: "test-host", pid: process.pid });
    const sandbox = await LocalInProcessSandbox.create({
      docker,
      store,
      runtime: "sysbox",
      instanceId: inst.id,
    });
    sandboxes.push(sandbox);

    const homeVolume = uniqueName("cogmo-task-home");
    homeVolumes.push(homeVolume);
    const taskId = "019d0000-0000-7000-8000-0000000000bb";

    const handle = await sandbox.createTaskContainer({
      rootTaskId: taskId,
      worktreePath: workspaceTmp,
      homeVolumeName: homeVolume,
      image: TEST_IMAGE,
      resourceLimits: RESOURCE_LIMITS,
      ttl: { expiresAt: new Date(Date.now() + 60_000) },
      allowPrivilegedRunc: false,
    });

    // Inside the container: `id -u` returns 0 (we run as root).
    const inExec = await handle.exec(["id", "-u"]);
    const inOut = await readToEnd(inExec.stdout);
    const inResult = await inExec.wait();
    expect(inResult.exitCode).toBe(0);
    expect(inOut.trim()).toBe("0");

    // Inside the container, /proc/self/uid_map reports the userns mapping.
    // Sysbox-style mapping looks like `         0      <hostuid>      <range>`
    // — the second column is the *host-side* uid for inner uid 0. Anything
    // other than `0` proves userns remapping is in effect. Under plain runc
    // (without userns-remap on the daemon) we'd see `0 0 4294967295`.
    const mapExec = await handle.exec(["cat", "/proc/self/uid_map"]);
    const mapOut = await readToEnd(mapExec.stdout);
    await mapExec.wait();
    const firstLine = mapOut.trim().split("\n")[0] ?? "";
    const cols = firstLine.split(/\s+/).filter((s) => s.length > 0);
    expect(cols.length).toBeGreaterThanOrEqual(3);
    const hostUidForRoot = Number.parseInt(cols[1] ?? "-1", 10);
    expect(hostUidForRoot).toBeGreaterThan(0);

    await sandbox.stopTask(taskId);
  });
});

async function readToEnd(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
