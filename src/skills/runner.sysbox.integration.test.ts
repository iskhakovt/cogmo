/// <reference path="../../test/vitest.d.ts" />

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
import { createTestDatabase } from "../test/pglite.js";
import { SkillRunnerImpl } from "./runner.js";
import { DrizzleSkillStore } from "./store/index.js";

function stubMemory(): MemoryProvider {
  return mock<MemoryProvider>();
}

function stubSecrets(): SecretsStore {
  return mock<SecretsStore>();
}

const noopFiles = {
  read: async () => "",
  write: async () => {},
  list: async () => [],
};

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
  }, 60_000);
});
