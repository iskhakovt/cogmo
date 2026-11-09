/// <reference path="../../test/vitest.d.ts" />

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import { profiles, users } from "../agent/store/schema.js";
import type { Transactor } from "../db/index.js";
import {
  CogmoSocketProxy,
  LocalDockerSandboxClient,
  type SandboxClient,
} from "../sandbox/index.js";
import { DrizzleSandboxStore } from "../sandbox/store/index.js";
import { LABEL_INSTANCE, LABEL_MANAGED } from "../sandbox/supervisor.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { assertStatus, expectDefined } from "../test/assertions.js";
import { mockFilesService } from "../test/factories.js";
import { createTestDatabase } from "../test/pglite.js";
import { offlineWasm } from "../test/skills-fixtures.js";
import { hashLockfileContents } from "./deps.js";
import type { SkillRunAs, SkillRunServices } from "./run-as.js";
import { SkillRunnerImpl } from "./runner.js";
import { DrizzleSkillStore } from "./store/index.js";
import { makeSandboxCpythonChecks } from "./worker-sysbox/check-session.js";
import { makeSandboxSchemaImporter } from "./worker-sysbox/schema-import.js";

function stubSecrets(): SecretsStore {
  return mock<SecretsStore>();
}

/** Who every run here runs as: real rows, which a run row references. */
let runAs: SkillRunAs;

/** No skill here is scheduled, so the identity never reaches a row. */
const DEFAULT_RUN_AS = { userId: "u-1", profileId: "p-1" };

/**
 * End-to-end container worker test against a real sysbox container running
 * `cogmo-skills:test` (loaded into the local Docker daemon by the
 * sysbox-e2e workflow's `bake --load` step before tests run). Validates:
 *
 *   - Image pull on first call (`ensureImagePresent`).
 *   - Container creation without worktree/home (container-tier contract).
 *   - NDJSON-over-stdio RPC against real Python.
 *   - `ctx.now` round-trip (bridge correctness).
 *   - Wall-clock expiry reported as `wall_clock_exceeded`.
 *   - Task isolation on a warm worker: a process a skill leaves behind is
 *     gone before the next skill runs, and a skill cannot open its relay's
 *     or the supervisor's host channel through `/proc`.
 *   - `$HOME`, which tasks on a worker share and can write, reaches neither
 *     a later task's imports nor the venv populate's uv configuration, and
 *     a task cannot replace the runtime venv's `python3`.
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
let wasmRoot: string;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  wasmRoot = await mkdtemp(join(tmpdir(), "runner-sysbox-wasm-"));
  const testDb = await createTestDatabase();
  ({ tx, close } = testDb);
  const [user] = await testDb.db.insert(users).values({}).returning({ id: users.id });
  const [profile] = await testDb.db
    .insert(profiles)
    .values({ userId: null, name: "default", basePrompt: "", model: "m", toolSet: [] })
    .returning({ id: profiles.id });
  runAs = {
    userId: expectDefined(user, "user").id,
    profileId: expectDefined(profile, "profile").id,
    service: { memory: mock<SkillRunServices["memory"]>(), files: mockFilesService() },
  };
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
  await rm(wasmRoot, { recursive: true, force: true });
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
description: a container sysbox skill
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
name: container-check-pid
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

/**
 * Lockfile recorded by running `echo "idna==3.10" | uv pip compile
 * --generate-hashes --no-header --quiet --only-binary=:all: -` against
 * the same `cogmo-skills:test` image the sandbox uses. Idna is a
 * pure-Python single-package dep (no transitive graph), so the
 * populator's `uv pip sync --require-hashes` step exercises the
 * shared-volume mount + activation path with the smallest possible
 * wheel surface (~80 KB).
 *
 * **Refresh trigger: PyPI yanks idna==3.10.** If `uv pip sync` starts
 * failing with a "hash mismatch" or "file not found" error here, the
 * pinned version no longer exists upstream. Pick the current stable
 * (`pip index versions idna`), re-run the compile command above,
 * and replace the hashes + the expected versions in the assertions.
 */
const IDNA_LOCKFILE = `idna==3.10 \\
    --hash=sha256:12f65c9b470abda6dc35cf8e63cc574b1c52b11df2c86030af0ac09b01b13ea9 \\
    --hash=sha256:946d195a0d259cbba61165e88e65941f16e9b36ea6ddb97f00452bae8b1287d3
`;

const depsManifest = (name: string) => `---
name: ${name}
description: a container skill that imports a declared dependency
tier: container
dependencies:
  - "idna==3.10"
inputs:
  type: object
  properties: {}
---
`;

/**
 * Writes a `csv.py` into the task's cwd, which is the supervisor's, and into
 * `$HOME`: on a warm worker every task can write both.
 */
const PLANT_MODULE_BODY = `
import os, socket

async def run(inputs, ctx):
    for d in {os.getcwd(), os.path.expanduser("~")}:
        with open(os.path.join(d, "csv.py"), "w") as f:
            f.write("PLANTED = True\\n")
    return {"host": socket.gethostname()}
`;

const IMPORT_CSV_BODY = `
import csv, socket

async def run(inputs, ctx):
    return {"host": socket.gethostname(), "planted": hasattr(csv, "PLANTED"), "file": csv.__file__}
`;

/**
 * Plants uv configuration in `$HOME`: a `.python-version` in the image's
 * working directory, and a user `uv.toml` and `.python-version`. Each asks
 * for an interpreter the image doesn't have, and downloads are off, so a
 * populate that reads any of them cannot create the venv.
 */
const PLANT_UV_CONFIG_BODY = `
import os, socket

async def run(inputs, ctx):
    home = os.path.expanduser("~")
    user = os.path.join(home, ".config", "uv")
    os.makedirs(user, exist_ok=True)
    for path, content in (
        (os.path.join(home, ".python-version"), "3.9\\n"),
        (os.path.join(user, ".python-version"), "3.9\\n"),
        (os.path.join(user, "uv.toml"), 'python-preference = "only-managed"\\n'),
    ):
        with open(path, "w") as f:
            f.write(content)
    return {"host": socket.gethostname()}
`;

/**
 * Plants a project in `$HOME`, the image's working directory, whose
 * `requires-python` no interpreter meets. uv reads it from the cwd even with
 * configuration discovery off, so only a populate run elsewhere ignores it.
 */
const PLANT_PROJECT_BODY = `
import os, socket

async def run(inputs, ctx):
    with open(os.path.join(os.path.expanduser("~"), "pyproject.toml"), "w") as f:
        f.write('[project]\\nname = "planted"\\nversion = "0"\\nrequires-python = ">=3.99"\\n')
    return {"host": socket.gethostname()}
`;

/** The planting task's output: the container it ran in. */
const HostSchema = z.object({ host: z.string() });

/**
 * Tries to swap the runtime venv's `python3`, first on PATH for the populate
 * and reap scripts, for a script of its own.
 */
const REPLACE_RUNTIME_PYTHON_BODY = `
import os

async def run(inputs, ctx):
    target = "/opt/cogmo-skills/.venv/bin/python3"
    planted = target + ".planted"
    try:
        with open(planted, "w") as f:
            f.write("#!/bin/sh\\necho planted\\n")
        os.chmod(planted, 0o755)
        os.replace(planted, target)
    except PermissionError:
        return {"replaced": False}
    return {"replaced": True}
`;

const IDNA_HOST_BODY = `
import importlib.metadata as md
import socket
import idna

async def run(inputs, ctx):
    return {"host": socket.gethostname(), "version": md.version("idna")}
`;

describe.skipIf(!SHOULD_RUN)("SkillRunnerImpl container (sysbox runtime, GHA only)", () => {
  it("invokes a container skill end-to-end against cogmo-skills:test", async () => {
    const runner = await SkillRunnerImpl.create({
      releaseVersion: "dev",
      runInTx: tx,
      store: skillStore,
      secretsStore: stubSecrets(),
      sandbox,
      containerImage: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
      // Every skill here runs on the container tier.
      ...offlineWasm(wasmRoot),
    });

    try {
      await runner.__registerForTests({
        name: "container-now",
        manifestSource: containerManifest("container-now"),
        body: NOW_BODY,
      });

      const result = (
        await runner.invoke({ name: "container-now", inputs: { x: 7 }, runAs })
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

  it("kills a container skill that exceeds wall_clock_s", async () => {
    const runner = await SkillRunnerImpl.create({
      releaseVersion: "dev",
      runInTx: tx,
      store: skillStore,
      secretsStore: stubSecrets(),
      sandbox,
      containerImage: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
      // Every skill here runs on the container tier.
      ...offlineWasm(wasmRoot),
    });

    const slowManifest = `---
name: container-sleep
description: a container skill that sleeps longer than its wall clock
tier: container
inputs:
  type: object
  properties: {}
resources:
  wall_clock_s: 2
---
`;
    await runner.__registerForTests({
      name: "container-sleep",
      manifestSource: slowManifest,
      body: SLEEP_BODY,
    });

    const start = Date.now();
    const result = (
      await runner.invoke({ name: "container-sleep", inputs: {}, runAs })
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
      releaseVersion: "dev",
      runInTx: tx,
      store: skillStore,
      secretsStore: stubSecrets(),
      sandbox,
      containerImage: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
      // Every skill here runs on the container tier.
      ...offlineWasm(wasmRoot),
      // Default min=1: the runner.create call eagerly spawns one worker
      // before the first invoke, so both invokes run on a warm container.
      // Tighter idle/recycle caps don't matter for a two-task test.
    });

    try {
      await runner.__registerForTests({
        name: "container-host",
        manifestSource: containerManifest("container-host"),
        body: HOSTNAME_BODY,
      });

      const r1 = (
        await runner.invoke({ name: "container-host", inputs: {}, runAs })
      )._unsafeUnwrap();
      const r2 = (
        await runner.invoke({ name: "container-host", inputs: {}, runAs })
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

  it("invokes a container skill with declared deps — populator + venv activation end-to-end", async () => {
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
      releaseVersion: "dev",
      runInTx: tx,
      store: skillStore,
      secretsStore: stubSecrets(),
      sandbox,
      containerImage: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
      // Every skill here runs on the container tier.
      ...offlineWasm(wasmRoot),
      depsCacheVolumeName,
    });
    try {
      await runner.__registerForTests({
        name: "container-with-deps",
        manifestSource: depsManifest("container-with-deps"),
        body: depsBody,
        lockfileContents: IDNA_LOCKFILE,
      });

      const result = (
        await runner.invoke({ name: "container-with-deps", inputs: {}, runAs })
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

  it("imports a container skill's models in a session with no network, from the venv register's install session populated", async () => {
    const depsCacheVolumeName = `cogmo-skills-test-deps-${randomUUID()}`;
    const lockfile = { hash: hashLockfileContents(IDNA_LOCKFILE), contents: IDNA_LOCKFILE };
    const importer = makeSandboxSchemaImporter({
      sandbox,
      image: SKILLS_IMAGE,
      depsCacheVolumeName,
    });
    try {
      // Register's install session, ahead of its check session, populates the venv.
      const checked = await makeSandboxCpythonChecks({
        sandbox,
        image: SKILLS_IMAGE,
        depsCacheVolumeName,
      }).check({
        body: 'import idna\n\nHOST = idna.encode("b\u00fccher.example")\n',
        dependencies: ["idna==3.10"],
        lockfile,
        signal: undefined,
      });
      expect(checked._unsafeUnwrap().findings).toEqual([]);
      const imported = await importer.importSchemas({
        body: `
import socket
import idna
from pydantic import BaseModel

try:
    socket.create_connection(("1.1.1.1", 53), timeout=2).close()
    reached = "reached"
except OSError as e:
    reached = type(e).__name__
print("a module's print goes to stderr")

class Input(BaseModel):
    host: str = idna.encode("bücher.example").decode("ascii")
    reached: str = reached
`,
        lockfile,
        resourceLimits: {},
        timeoutMs: 60_000,
      });

      // The install session's venv reached the import, which reached no network.
      const properties = imported._unsafeUnwrap().inputs?.properties;
      expect(properties).toMatchObject({
        host: { default: "xn--bcher-kva.example" },
        // No route out of a session with no network: connect fails at once.
        reached: { default: "OSError" },
      });
    } finally {
      await docker
        .getVolume(depsCacheVolumeName)
        .remove()
        .catch(() => {});
    }
  }, 180_000);

  it("isolates module-level state between sequential tasks (fresh fork per task)", async () => {
    const runner = await SkillRunnerImpl.create({
      releaseVersion: "dev",
      runInTx: tx,
      store: skillStore,
      secretsStore: stubSecrets(),
      sandbox,
      containerImage: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
      // Every skill here runs on the container tier.
      ...offlineWasm(wasmRoot),
    });

    await runner.__registerForTests({
      name: "container-leak",
      manifestSource: containerManifest("container-leak"),
      body: STATE_LEAK_BODY,
    });

    const r1 = (await runner.invoke({ name: "container-leak", inputs: {}, runAs }))._unsafeUnwrap();
    const r2 = (await runner.invoke({ name: "container-leak", inputs: {}, runAs }))._unsafeUnwrap();
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
      releaseVersion: "dev",
      runInTx: tx,
      store: skillStore,
      secretsStore: stubSecrets(),
      sandbox,
      containerImage: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
      // Every skill here runs on the container tier.
      ...offlineWasm(wasmRoot),
    });
    try {
      await runner.__registerForTests({
        name: "container-leave-sleeper",
        manifestSource: containerManifest("container-leave-sleeper"),
        body: LEAVE_SLEEPER_BODY,
      });
      await runner.__registerForTests({
        name: "container-check-pid",
        manifestSource: checkPidManifest,
        body: CHECK_PID_BODY,
      });

      const left = (
        await runner.invoke({ name: "container-leave-sleeper", inputs: {}, runAs })
      )._unsafeUnwrap();
      assertStatus(left, "success");
      const { host, pid } = left.output as { host: string; pid: number };
      const checked = (
        await runner.invoke({
          name: "container-check-pid",
          inputs: { pid },
          runAs,
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
      releaseVersion: "dev",
      runInTx: tx,
      store: skillStore,
      secretsStore: stubSecrets(),
      sandbox,
      containerImage: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
      // Every skill here runs on the container tier.
      ...offlineWasm(wasmRoot),
    });
    try {
      await runner.__registerForTests({
        name: "container-proc-probe",
        manifestSource: containerManifest("container-proc-probe"),
        body: PROC_FD_PROBE_BODY,
      });

      const result = (
        await runner.invoke({ name: "container-proc-probe", inputs: {}, runAs })
      )._unsafeUnwrap();
      assertStatus(result, "success");
      expect(result.output).toEqual({ opened: [], control: true });
    } finally {
      await runner.shutdown();
    }
  }, 180_000);

  it("a module a task plants in $HOME never loads in a later task on the worker", async () => {
    const runner = await SkillRunnerImpl.create({
      releaseVersion: "dev",
      runInTx: tx,
      store: skillStore,
      secretsStore: stubSecrets(),
      sandbox,
      containerImage: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
      // Every skill here runs on the container tier.
      ...offlineWasm(wasmRoot),
    });
    try {
      await runner.__registerForTests({
        name: "container-plant-module",
        manifestSource: containerManifest("container-plant-module"),
        body: PLANT_MODULE_BODY,
      });
      await runner.__registerForTests({
        name: "container-import-csv",
        manifestSource: containerManifest("container-import-csv"),
        body: IMPORT_CSV_BODY,
      });

      const planted = (
        await runner.invoke({ name: "container-plant-module", inputs: {}, runAs })
      )._unsafeUnwrap();
      assertStatus(planted, "success");
      const imported = (
        await runner.invoke({ name: "container-import-csv", inputs: {}, runAs })
      )._unsafeUnwrap();
      assertStatus(imported, "success");
      const { host } = HostSchema.parse(planted.output);
      // Same container, so the planted file is on the importing task's disk.
      expect(imported.output).toEqual({
        host,
        planted: false,
        file: expect.stringMatching(/^\/usr\/local\/lib\/python3\.\d+\/csv\.py$/),
      });
    } finally {
      await runner.shutdown();
    }
  }, 180_000);

  it("a populate ignores uv configuration a task planted in $HOME", async () => {
    const depsCacheVolumeName = `cogmo-skills-test-deps-${randomUUID()}`;
    const runner = await SkillRunnerImpl.create({
      releaseVersion: "dev",
      runInTx: tx,
      store: skillStore,
      secretsStore: stubSecrets(),
      sandbox,
      containerImage: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
      // Every skill here runs on the container tier.
      ...offlineWasm(wasmRoot),
      depsCacheVolumeName,
    });
    try {
      await runner.__registerForTests({
        name: "container-plant-uv-config",
        manifestSource: containerManifest("container-plant-uv-config"),
        body: PLANT_UV_CONFIG_BODY,
      });
      await runner.__registerForTests({
        name: "container-idna-host",
        manifestSource: depsManifest("container-idna-host"),
        body: IDNA_HOST_BODY,
        lockfileContents: IDNA_LOCKFILE,
      });

      const planted = (
        await runner.invoke({ name: "container-plant-uv-config", inputs: {}, runAs })
      )._unsafeUnwrap();
      assertStatus(planted, "success");
      // Its venv is populated on the worker the planting task ran on.
      const populated = (
        await runner.invoke({ name: "container-idna-host", inputs: {}, runAs })
      )._unsafeUnwrap();
      assertStatus(populated, "success");
      const { host } = HostSchema.parse(planted.output);
      expect(populated.output, JSON.stringify(populated)).toEqual({ host, version: "3.10" });
    } finally {
      await runner.shutdown();
      await docker
        .getVolume(depsCacheVolumeName)
        .remove()
        .catch(() => {});
    }
  }, 180_000);

  it("a populate ignores a project a task planted in its working directory", async () => {
    const depsCacheVolumeName = `cogmo-skills-test-deps-${randomUUID()}`;
    const runner = await SkillRunnerImpl.create({
      releaseVersion: "dev",
      runInTx: tx,
      store: skillStore,
      secretsStore: stubSecrets(),
      sandbox,
      containerImage: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
      // Every skill here runs on the container tier.
      ...offlineWasm(wasmRoot),
      depsCacheVolumeName,
    });
    try {
      await runner.__registerForTests({
        name: "container-plant-project",
        manifestSource: containerManifest("container-plant-project"),
        body: PLANT_PROJECT_BODY,
      });
      await runner.__registerForTests({
        name: "container-idna-project",
        manifestSource: depsManifest("container-idna-project"),
        body: IDNA_HOST_BODY,
        lockfileContents: IDNA_LOCKFILE,
      });

      const planted = (
        await runner.invoke({ name: "container-plant-project", inputs: {}, runAs })
      )._unsafeUnwrap();
      assertStatus(planted, "success");
      const populated = (
        await runner.invoke({ name: "container-idna-project", inputs: {}, runAs })
      )._unsafeUnwrap();
      assertStatus(populated, "success");
      const { host } = HostSchema.parse(planted.output);
      expect(populated.output, JSON.stringify(populated)).toEqual({ host, version: "3.10" });
    } finally {
      await runner.shutdown();
      await docker
        .getVolume(depsCacheVolumeName)
        .remove()
        .catch(() => {});
    }
  }, 180_000);

  it("a task cannot replace the runtime venv's python3", async () => {
    const runner = await SkillRunnerImpl.create({
      releaseVersion: "dev",
      runInTx: tx,
      store: skillStore,
      secretsStore: stubSecrets(),
      sandbox,
      containerImage: SKILLS_IMAGE,
      userTimezone: "UTC",
      defaultRunAs: DEFAULT_RUN_AS,
      // Every skill here runs on the container tier.
      ...offlineWasm(wasmRoot),
    });
    try {
      await runner.__registerForTests({
        name: "container-replace-python",
        manifestSource: containerManifest("container-replace-python"),
        body: REPLACE_RUNTIME_PYTHON_BODY,
      });

      const result = (
        await runner.invoke({ name: "container-replace-python", inputs: {}, runAs })
      )._unsafeUnwrap();
      assertStatus(result, "success");
      expect(result.output).toEqual({ replaced: false });
    } finally {
      await runner.shutdown();
    }
  }, 180_000);
});
