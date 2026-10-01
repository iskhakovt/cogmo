/// <reference path="../../test/vitest.d.ts" />

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../db/index.js";
import {
  CogmoSocketProxy,
  LocalDockerSandboxClient,
  type SandboxClient,
} from "../sandbox/index.js";
import { DrizzleSandboxStore } from "../sandbox/store/index.js";
import { LABEL_INSTANCE, LABEL_MANAGED } from "../sandbox/supervisor.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { assertStatus } from "../test/assertions.js";
import { mockFilesService } from "../test/factories.js";
import { createTestDatabase } from "../test/pglite.js";
import type { SkillRunAs, SkillRunServices } from "./run-as.js";
import { SkillRunnerImpl } from "./runner.js";
import { DrizzleSkillStore } from "./store/index.js";

function stubSecrets(): SecretsStore {
  return mock<SecretsStore>();
}

const RUN_AS: SkillRunAs = {
  userId: "u-1",
  service: { memory: mock<SkillRunServices["memory"]>(), files: mockFilesService() },
};

/** No skill here is scheduled, so the identity never reaches a row. */
const DEFAULT_RUN_AS = { userId: "u-1", profileId: "p-1" };

/**
 * End-to-end tier-2 worker test against a real sysbox container running
 * `cogmo-skills:test` (loaded into the local Docker daemon by the
 * sysbox-e2e workflow's `bake --load` step before tests run). Validates:
 *
 *   - Image pull on first call (`ensureImagePresent`).
 *   - Container creation without worktree/home (skills tier-2 contract).
 *   - NDJSON-over-stdio RPC against real Python.
 *   - `ctx.now` round-trip (bridge correctness).
 *   - Wall-clock expiry reported as `wall_clock_exceeded`.
 *   - Task isolation on a warm worker: a process a skill leaves behind is
 *     gone before the next skill runs, and a skill cannot open its relay's
 *     or the supervisor's host channel through `/proc`.
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

  // Sweep any `cogmo-skills-test-deps-*` volumes left behind by prior
  // runs that were SIGKILLed / OOMed / CI-timed-out before their
  // `finally` could fire. CI runners are ephemeral so this matters
  // on dev machines where the volume accumulation otherwise grows
  // until disk pressure forces a manual `docker volume prune`.
  const leftoverVolumes = await docker.listVolumes();
  for (const v of leftoverVolumes.Volumes ?? []) {
    if (v.Name.startsWith("cogmo-skills-test-deps-")) {
      await docker
        .getVolume(v.Name)
        .remove()
        .catch(() => {
          // In-use or already gone; the next sweep catches whatever survives.
        });
    }
  }

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
 * default), the task's parent (its relay) and grandparent (the
 * supervisor). Two invocations on the same warm worker share the
 * container and the supervisor, and each gets its own relay.
 */
const HOSTNAME_BODY = `
import os, socket

def _ppid(pid):
    with open(f"/proc/{pid}/stat") as f:
        stat = f.read()
    # Field 4; the command name before it may contain spaces or parens.
    return int(stat[stat.rindex(")") + 2:].split()[1])

async def run(inputs, ctx):
    relay = os.getppid()
    return {"host": socket.gethostname(), "relay": relay, "supervisor": _ppid(relay)}
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

/**
 * Leaves a grandchild in a new session with stdin/stdout/stderr closed, so
 * no pipe EOF or hangup ends it — only the supervisor's sweep can.
 */
const LEAVE_SLEEPER_BODY = `
import os, socket, time

async def run(inputs, ctx):
    r, w = os.pipe()
    if os.fork() == 0:
        os.setsid()
        if os.fork() == 0:
            for fd in (0, 1, 2):
                os.close(fd)
            os.write(w, str(os.getpid()).encode())
            os.close(w)
            time.sleep(300)
        os._exit(0)
    os.close(w)
    return {"host": socket.gethostname(), "pid": int(os.read(r, 32))}
`;

/** Whether `inputs.pid` is still a live (non-zombie) process. */
const CHECK_PID_BODY = `
import socket

async def run(inputs, ctx):
    try:
        with open(f"/proc/{inputs['pid']}/stat") as f:
            stat = f.read()
    except FileNotFoundError:
        return {"host": socket.gethostname(), "alive": False}
    return {"host": socket.gethostname(), "alive": stat[stat.rindex(")") + 2] != "Z"}
`;

const checkPidManifest = `---
name: tier2-check-pid
description: reports whether a pid is alive
tier: container
inputs:
  type: object
  properties:
    pid:
      type: integer
---
`;

/**
 * Tries to open stdin and stdout of the task's relay and of the supervisor
 * through `/proc`. `control` opens the task's own stdin the same way, so
 * an empty `opened` means refused rather than unreachable.
 */
const PROC_FD_PROBE_BODY = `
import os

def _ppid(pid):
    with open(f"/proc/{pid}/stat") as f:
        stat = f.read()
    return int(stat[stat.rindex(")") + 2:].split()[1])

def _can_open(path, flags):
    try:
        os.close(os.open(path, flags))
        return True
    except PermissionError:
        return False

async def run(inputs, ctx):
    relay = os.getppid()
    opened = [
        f"{pid}/{fd}"
        for pid in (relay, _ppid(relay))
        for fd, flags in ((0, os.O_RDONLY), (1, os.O_WRONLY))
        if _can_open(f"/proc/{pid}/fd/{fd}", flags)
    ]
    return {"opened": opened, "control": _can_open(f"/proc/{os.getpid()}/fd/0", os.O_RDONLY)}
`;

describe.skipIf(!SHOULD_RUN)("SkillRunnerImpl tier-2 (sysbox runtime, GHA only)", () => {
  it("invokes a tier-2 skill end-to-end against cogmo-skills:test", async () => {
    const runner = await SkillRunnerImpl.create({
      runInTx: tx,
      store: skillStore,
      secretsStore: stubSecrets(),
      sandbox,
      tier2Image: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
    });

    try {
      await runner.__registerForTests({
        name: "tier2-now",
        manifestSource: containerManifest("tier2-now"),
        body: NOW_BODY,
      });

      const result = (
        await runner.invoke({ name: "tier2-now", inputs: { x: 7 }, runAs: RUN_AS })
      )._unsafeUnwrap();
      assertStatus(result, "success");
      expect(result.output).toMatchObject({ echoed: 8 });
      // ctx.now returns an ISO-8601 string from the host's clock.
      expect((result.output as { got: string }).got).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
    } finally {
      await runner.shutdown();
    }
  }, 180_000);

  it("kills a tier-2 container that exceeds wall_clock_s", async () => {
    const runner = await SkillRunnerImpl.create({
      runInTx: tx,
      store: skillStore,
      secretsStore: stubSecrets(),
      sandbox,
      tier2Image: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
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
    const result = (
      await runner.invoke({ name: "tier2-sleep", inputs: {}, runAs: RUN_AS })
    )._unsafeUnwrap();
    const elapsedMs = Date.now() - start;
    assertStatus(result, "error");
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
      secretsStore: stubSecrets(),
      sandbox,
      tier2Image: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
      // Default min=1: the runner.create call eagerly spawns one worker
      // before the first invoke, so both invokes run on a warm container.
      // Tighter idle/recycle caps don't matter for a two-task test.
    });

    try {
      await runner.__registerForTests({
        name: "tier2-host",
        manifestSource: containerManifest("tier2-host"),
        body: HOSTNAME_BODY,
      });

      const r1 = (
        await runner.invoke({ name: "tier2-host", inputs: {}, runAs: RUN_AS })
      )._unsafeUnwrap();
      const r2 = (
        await runner.invoke({ name: "tier2-host", inputs: {}, runAs: RUN_AS })
      )._unsafeUnwrap();
      assertStatus(r1, "success");
      assertStatus(r2, "success");
      const o1 = r1.output as { host: string; relay: number; supervisor: number };
      const o2 = r2.output as { host: string; relay: number; supervisor: number };
      // Same container — pool reused the warm worker.
      expect(o1.host).toBe(o2.host);
      expect(o1.host).toMatch(/^[0-9a-f]{12}$/);
      // Same supervisor across tasks: it is long-lived, and a supervisor
      // per task would show a different grandparent.
      expect(o1.supervisor).toBe(o2.supervisor);
      // A relay per task: the task's parent is new each time.
      expect(o1.relay).not.toBe(o2.relay);
    } finally {
      await runner.shutdown();
    }
  }, 180_000);

  it("invokes a tier-2 skill with declared deps — populator + venv activation end-to-end", async () => {
    // Lockfile recorded by running `echo "idna==3.10" | uv pip compile
    // --generate-hashes --no-header --quiet --only-binary=:all: -` against
    // the same `cogmo-skills:test` image the sandbox uses. Idna is a
    // pure-Python single-package dep (no transitive graph), so the
    // populator's `uv pip sync --require-hashes` step exercises the
    // shared-volume mount + activation path with the smallest possible
    // wheel surface (~80 KB).
    //
    // **Refresh trigger: PyPI yanks idna==3.10.** If `uv pip sync` starts
    // failing with a "hash mismatch" or "file not found" error here, the
    // pinned version no longer exists upstream. Pick the current stable
    // (`pip index versions idna`), re-run the compile command above,
    // and replace the hashes + the assertion's expected version below.
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
      secretsStore: stubSecrets(),
      sandbox,
      tier2Image: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
      depsCacheVolumeName,
    });
    try {
      await runner.__registerForTests({
        name: "tier2-with-deps",
        manifestSource: depsManifest,
        body: depsBody,
        lockfileContents: idnaLockfile,
      });

      const result = (
        await runner.invoke({ name: "tier2-with-deps", inputs: {}, runAs: RUN_AS })
      )._unsafeUnwrap();
      assertStatus(result, "success");
      // Pass `result` as the assertion-failure label so a mismatch
      // surfaces the whole row (error string, runId, etc.) rather than
      // just the matchObject diff.
      expect(result.output, JSON.stringify(result)).toMatchObject({
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
      secretsStore: stubSecrets(),
      sandbox,
      tier2Image: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
    });

    await runner.__registerForTests({
      name: "tier2-leak",
      manifestSource: containerManifest("tier2-leak"),
      body: STATE_LEAK_BODY,
    });

    const r1 = (
      await runner.invoke({ name: "tier2-leak", inputs: {}, runAs: RUN_AS })
    )._unsafeUnwrap();
    const r2 = (
      await runner.invoke({ name: "tier2-leak", inputs: {}, runAs: RUN_AS })
    )._unsafeUnwrap();
    assertStatus(r1, "success");
    assertStatus(r2, "success");
    // Task 1 sets `sys.modules["_cogmo_test_marker"]`. Task 2 runs in a
    // fresh fork from the supervisor, so its `sys.modules` is the
    // supervisor's snapshot at fork time — the marker isn't there.
    expect((r1.output as { seen_before: boolean }).seen_before).toBe(false);
    expect((r2.output as { seen_before: boolean }).seen_before).toBe(false);

    await runner.shutdown();
  }, 180_000);

  it("kills a process a skill leaves behind before the next skill runs on the worker", async () => {
    const runner = await SkillRunnerImpl.create({
      runInTx: tx,
      store: skillStore,
      secretsStore: stubSecrets(),
      sandbox,
      tier2Image: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
    });
    try {
      await runner.__registerForTests({
        name: "tier2-leave-sleeper",
        manifestSource: containerManifest("tier2-leave-sleeper"),
        body: LEAVE_SLEEPER_BODY,
      });
      await runner.__registerForTests({
        name: "tier2-check-pid",
        manifestSource: checkPidManifest,
        body: CHECK_PID_BODY,
      });

      const left = (
        await runner.invoke({ name: "tier2-leave-sleeper", inputs: {}, runAs: RUN_AS })
      )._unsafeUnwrap();
      assertStatus(left, "success");
      const { host, pid } = left.output as { host: string; pid: number };
      const checked = (
        await runner.invoke({
          name: "tier2-check-pid",
          inputs: { pid },
          runAs: RUN_AS,
        })
      )._unsafeUnwrap();
      assertStatus(checked, "success");
      // Same container, so the pid names the same process namespace.
      expect(checked.output).toEqual({ host, alive: false });
    } finally {
      await runner.shutdown();
    }
  }, 180_000);

  it("a skill cannot open its relay's or the supervisor's host channel through /proc", async () => {
    const runner = await SkillRunnerImpl.create({
      runInTx: tx,
      store: skillStore,
      secretsStore: stubSecrets(),
      sandbox,
      tier2Image: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
    });
    try {
      await runner.__registerForTests({
        name: "tier2-proc-probe",
        manifestSource: containerManifest("tier2-proc-probe"),
        body: PROC_FD_PROBE_BODY,
      });

      const result = (
        await runner.invoke({ name: "tier2-proc-probe", inputs: {}, runAs: RUN_AS })
      )._unsafeUnwrap();
      assertStatus(result, "success");
      expect(result.output).toEqual({ opened: [], control: true });
    } finally {
      await runner.shutdown();
    }
  }, 180_000);
});
