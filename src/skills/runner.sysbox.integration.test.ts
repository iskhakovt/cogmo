/// <reference path="../../test/vitest.d.ts" />

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../db/index.js";
import type { MemoryProvider } from "../memory/provider.js";
import {
  CogmoSocketProxy,
  LocalDockerSandboxClient,
  type SandboxClient,
} from "../sandbox/index.js";
import { DrizzleSandboxStore } from "../sandbox/store/index.js";
import { LABEL_INSTANCE, LABEL_MANAGED } from "../sandbox/supervisor.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { mockFilesService } from "../test/factories.js";
import { createTestDatabase } from "../test/pglite.js";
import { SkillRunnerImpl } from "./runner.js";
import { DrizzleSkillStore } from "./store/index.js";

function stubMemory(): MemoryProvider {
  return mock<MemoryProvider>();
}

function stubSecrets(): SecretsStore {
  return mock<SecretsStore>();
}

const noopFiles = mockFilesService();

/**
 * End-to-end tier-2 worker test against a real sysbox container running
 * `cogmo-skills:test` (loaded into the local Docker daemon by the
 * sysbox-e2e workflow's `bake --load` step before tests run). Validates:
 *
 *   - Image pull on first call (`ensureImagePresent`).
 *   - Container creation without worktree/home (skills tier-2 contract).
 *   - NDJSON-over-stdio RPC against real Python.
 *   - `ctx.now` round-trip (bridge correctness).
 *   - Wall-clock kill via `deleteByTaskId`.
 *
 * Gated by `SANDBOX_RUNTIME=sysbox`. Skipped on dev machines without
 * sysbox; runs in the GHA `sysbox-e2e` job. Mirrors the supervisor's own
 * sysbox integration test in shape.
 */

const SHOULD_RUN = process.env.SANDBOX_RUNTIME === "sysbox";
// Local test image. The sysbox-e2e workflow runs `bake --load` with
// `VERSION=test`, which writes this tag into the local Docker daemon
// before the test starts. The runner's `ensureImagePresent` then inspects
// it locally — no registry round-trip. Local-dev convention to mirror CI:
//   VERSION=test docker buildx bake --load skills
const SKILLS_IMAGE = "ghcr.io/iskhakovt/cogmo-skills:test";

let tx: Transactor;
let close: () => Promise<void>;
let agentStore: DrizzleSandboxStore;
let skillStore: DrizzleSkillStore;
let docker: Docker;
let proxy: CogmoSocketProxy;
let sandbox: SandboxClient;
let instanceId: string;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  ({ tx, close } = await createTestDatabase());
  agentStore = new DrizzleSandboxStore();
  skillStore = new DrizzleSkillStore();
  docker = new Docker();

  // Fail loudly if the dev forgot to bake the image first. CI's sysbox-e2e
  // workflow does this for free; locally it's an explicit step that the
  // runner's deep `image not found` doesn't surface clearly.
  try {
    await docker.getImage(SKILLS_IMAGE).inspect();
  } catch {
    throw new Error(
      `${SKILLS_IMAGE} not loaded into local Docker. Run \`VERSION=test docker buildx bake --load skills\` before \`pnpm test:integration\`.`,
    );
  }

  const instance = await tx((trx) =>
    agentStore.insertInstance(trx, { host: hostname(), pid: process.pid }),
  );
  instanceId = instance.id;
  proxy = await CogmoSocketProxy.create({
    socketDir: "/tmp/cogmo-test-skills-proxy",
    hostDockerSocket: "/var/run/docker.sock",
  });
  sandbox = await LocalDockerSandboxClient.create({
    docker,
    store: agentStore,
    runInTx: tx,
    runtime: "sysbox",
    instanceId: instance.id,
    proxy,
    askpassBaseDir: "/tmp/cogmo-test-skills-askpass",
  });
}, 180_000);

afterAll(async () => {
  if (!SHOULD_RUN) return;
  if (sandbox) await sandbox.shutdown();
  // Belt-and-suspenders cleanup, scoped to this test's instance label so
  // parallel test files (or stray containers from unrelated runs on the
  // same daemon) aren't clobbered. The supervisor's own teardown should
  // handle everything; this is the safety net for crashes mid-run.
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
  await close();
});

const NOW_BODY = `
async def run(inputs, ctx):
    t = await ctx.now()
    return {"got": t, "echoed": inputs.get("x", 0) + 1}
`;

const SLEEP_BODY = `
import asyncio
async def run(inputs, ctx):
    await asyncio.sleep(60)
    return {"unreachable": True}
`;

/**
 * Returns the container's hostname (= docker short container ID by
 * default) and the supervisor's PID. Two invocations from the same warm
 * worker share both — the container survives across tasks AND the
 * supervisor process survives across tasks (forking children per task).
 */
const HOSTNAME_BODY = `
import os, socket
async def run(inputs, ctx):
    return {"host": socket.gethostname(), "ppid": os.getppid()}
`;

/**
 * Sets a global on the first call, asserts the global is gone on the next.
 * Validates per-task process isolation: the supervisor forks a fresh child
 * per task, so module-level state from task 1 can't leak into task 2.
 */
const STATE_LEAK_BODY = `
import sys
async def run(inputs, ctx):
    seen_before = "_cogmo_test_marker" in sys.modules
    sys.modules["_cogmo_test_marker"] = object()
    return {"seen_before": seen_before}
`;

const containerManifest = (name: string) => `---
name: ${name}
description: a tier-2 sysbox skill
tier: container
inputs:
  type: object
  properties:
    x:
      type: integer
---
`;

describe.skipIf(!SHOULD_RUN)("SkillRunnerImpl tier-2 (sysbox runtime, GHA only)", () => {
  it("invokes a tier-2 skill end-to-end against cogmo-skills:test", async () => {
    const runner = await SkillRunnerImpl.create({
      runInTx: tx,
      store: skillStore,
      memory: stubMemory(),
      secretsStore: stubSecrets(),
      files: noopFiles,
      sandbox,
      tier2Image: SKILLS_IMAGE,
      user: { id: "u-1", timezone: "UTC" },
      memoryBankId: "bank-1",
    });

    await runner.__registerForTests({
      name: "tier2-now",
      manifestSource: containerManifest("tier2-now"),
      body: NOW_BODY,
    });

    const result = await runner.invoke({ name: "tier2-now", inputs: { x: 7 } });
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject({ echoed: 8 });
    // ctx.now returns an ISO-8601 string from the host's clock.
    expect((result.output as { got: string }).got).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  }, 180_000);

  it("kills a tier-2 container that exceeds wall_clock_s", async () => {
    const runner = await SkillRunnerImpl.create({
      runInTx: tx,
      store: skillStore,
      memory: stubMemory(),
      secretsStore: stubSecrets(),
      files: noopFiles,
      sandbox,
      tier2Image: SKILLS_IMAGE,
      user: { id: "u-1", timezone: "UTC" },
      memoryBankId: "bank-1",
    });

    const slowManifest = `---
name: tier2-sleep
description: a tier-2 skill that sleeps longer than its wall clock
tier: container
inputs:
  type: object
  properties: {}
resources:
  wall_clock_s: 2
---
`;
    await runner.__registerForTests({
      name: "tier2-sleep",
      manifestSource: slowManifest,
      body: SLEEP_BODY,
    });

    const start = Date.now();
    const result = await runner.invoke({ name: "tier2-sleep", inputs: {} });
    const elapsedMs = Date.now() - start;
    expect(result.status).toBe("error");
    expect(result.error).toBe("wall_clock_exceeded");
    // The kill must land before the skill's own 60 s sleep would resolve.
    // Generous upper bound to absorb container startup + reaper jitter.
    expect(elapsedMs).toBeLessThan(30_000);

    await runner.shutdown();
  }, 60_000);

  it("two sequential invocations reuse the same warm worker", async () => {
    const runner = await SkillRunnerImpl.create({
      runInTx: tx,
      store: skillStore,
      memory: stubMemory(),
      secretsStore: stubSecrets(),
      files: noopFiles,
      sandbox,
      tier2Image: SKILLS_IMAGE,
      user: { id: "u-1", timezone: "UTC" },
      memoryBankId: "bank-1",
      // Default min=1: the runner.create call eagerly spawns one worker
      // before the first invoke, so both invokes run on a warm container.
      // Tighter idle/recycle caps don't matter for a two-task test.
    });

    await runner.__registerForTests({
      name: "tier2-host",
      manifestSource: containerManifest("tier2-host"),
      body: HOSTNAME_BODY,
    });

    const r1 = await runner.invoke({ name: "tier2-host", inputs: {} });
    const r2 = await runner.invoke({ name: "tier2-host", inputs: {} });
    expect(r1.status).toBe("success");
    expect(r2.status).toBe("success");
    const o1 = r1.output as { host: string; ppid: number };
    const o2 = r2.output as { host: string; ppid: number };
    // Same container — pool reused the warm worker.
    expect(o1.host).toBe(o2.host);
    expect(o1.host).toMatch(/^[0-9a-f]{12}$/);
    // Same supervisor process — children forked from it across tasks.
    // If supervisors are spawning per task, ppid would differ.
    expect(o1.ppid).toBe(o2.ppid);

    await runner.shutdown();
  }, 180_000);

  it("invokes a tier-2 skill with declared deps — populator + venv activation end-to-end", async () => {
    // Lockfile recorded by running `echo "idna==3.10" | uv pip compile
    // --generate-hashes --no-header --quiet --only-binary=:all: -` against
    // the same `cogmo-skills:test` image the sandbox uses. Idna is a
    // pure-Python single-package dep (no transitive graph), so the
    // populator's `uv pip sync --require-hashes` step exercises the
    // shared-volume mount + activation path with the smallest possible
    // wheel surface (~80 KB).
    const idnaLockfile = `idna==3.10 \\
    --hash=sha256:12f65c9b470abda6dc35cf8e63cc574b1c52b11df2c86030af0ac09b01b13ea9 \\
    --hash=sha256:946d195a0d259cbba61165e88e65941f16e9b36ea6ddb97f00452bae8b1287d3
`;
    const depsManifest = `---
name: tier2-with-deps
description: a tier-2 skill that imports a declared dependency
tier: container
dependencies:
  - "idna==3.10"
inputs:
  type: object
  properties: {}
---
`;
    const depsBody = `
import importlib.metadata as md
import idna
async def run(inputs, ctx):
    return {
        "version": md.version("idna"),
        "encoded": idna.encode("bücher.example").decode("ascii"),
    }
`;
    // Use the host-side dep volume name plumbed through SkillRunner so
    // the populator targets the same `/skill-venvs` mount the supervisor
    // activates. Volume name unique to this test so concurrent test
    // files don't collide on a shared host docker daemon.
    const depsCacheVolumeName = `cogmo-skills-test-deps-${randomUUID()}`;
    const runner = await SkillRunnerImpl.create({
      runInTx: tx,
      store: skillStore,
      memory: stubMemory(),
      secretsStore: stubSecrets(),
      files: noopFiles,
      sandbox,
      tier2Image: SKILLS_IMAGE,
      user: { id: "u-1", timezone: "UTC" },
      memoryBankId: "bank-1",
      depsCacheVolumeName,
    });
    try {
      await runner.__registerForTests({
        name: "tier2-with-deps",
        manifestSource: depsManifest,
        body: depsBody,
        lockfileContents: idnaLockfile,
      });

      const result = await runner.invoke({ name: "tier2-with-deps", inputs: {} });
      expect(result.status, JSON.stringify(result)).toBe("success");
      expect(result.output).toMatchObject({
        version: "3.10",
        // Bücher → xn--bcher-kva (IDN-encoded label). The encode call
        // proves the wheel actually loaded — a stub `idna` shim would
        // crash instead.
        encoded: "xn--bcher-kva.example",
      });
    } finally {
      await runner.shutdown();
      // Tear down the test-scoped volume so the host docker daemon
      // doesn't accumulate one per test run. Failure is benign — the
      // volume may already be gone, or another test in the same suite
      // might be using it (volume name is unique by Date.now()).
      await docker
        .getVolume(depsCacheVolumeName)
        .remove()
        .catch(() => {});
    }
  }, 180_000);

  it("isolates module-level state between sequential tasks (fresh fork per task)", async () => {
    const runner = await SkillRunnerImpl.create({
      runInTx: tx,
      store: skillStore,
      memory: stubMemory(),
      secretsStore: stubSecrets(),
      files: noopFiles,
      sandbox,
      tier2Image: SKILLS_IMAGE,
      user: { id: "u-1", timezone: "UTC" },
      memoryBankId: "bank-1",
    });

    await runner.__registerForTests({
      name: "tier2-leak",
      manifestSource: containerManifest("tier2-leak"),
      body: STATE_LEAK_BODY,
    });

    const r1 = await runner.invoke({ name: "tier2-leak", inputs: {} });
    const r2 = await runner.invoke({ name: "tier2-leak", inputs: {} });
    expect(r1.status).toBe("success");
    expect(r2.status).toBe("success");
    // Task 1 sets `sys.modules["_cogmo_test_marker"]`. Task 2 runs in a
    // fresh fork from the supervisor, so its `sys.modules` is the
    // supervisor's snapshot at fork time — the marker isn't there.
    expect((r1.output as { seen_before: boolean }).seen_before).toBe(false);
    expect((r2.output as { seen_before: boolean }).seen_before).toBe(false);

    await runner.shutdown();
  }, 180_000);
});
