import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/index.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { InputValidationError, SkillRunnerImpl } from "./runner.js";
import { DrizzleSkillStore } from "./store/index.js";

let db: Database;
let close: () => Promise<void>;
let store: DrizzleSkillStore;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  store = new DrizzleSkillStore(db);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

function makeMockMemory(): MemoryProvider {
  return {
    name: "mock",
    retain: vi.fn().mockResolvedValue(undefined),
    retainBatch: vi.fn().mockResolvedValue(undefined),
    recall: vi.fn().mockResolvedValue({ memories: [] }),
    reflect: vi.fn(),
  };
}

function makeMockSecrets(map: Record<string, string> = {}): SecretsStore {
  return {
    getSecret: vi.fn(async (name: string) => map[name] ?? null),
    getSecretById: vi.fn(),
    getSecretMeta: vi.fn(),
    listSecretNames: vi.fn(),
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: minimal SecretsStore stub
  } as any;
}

async function makeRunner(opts: { memory?: MemoryProvider; secretsStore?: SecretsStore } = {}) {
  return SkillRunnerImpl.create({
    store,
    memory: opts.memory ?? makeMockMemory(),
    secretsStore: opts.secretsStore ?? makeMockSecrets(),
    user: { id: "user-1", timezone: "UTC" },
    memoryBankId: "bank-1",
  });
}

const ECHO_MANIFEST = `---
name: echo
description: a tier-1 skill that echoes one int field
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

describe("SkillRunnerImpl", { timeout: 60_000 }, () => {
  it("registers a skill and lists it", async () => {
    const runner = await makeRunner();
    await runner.__registerForTests({
      name: "echo",
      manifestSource: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    const list = await runner.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("echo");
    expect(list[0]?.tier).toBe("wasm");
    expect(list[0]?.riskTier).toBe("auto");
  });

  it("invokes a tier-1 skill end-to-end (Pyodide load)", async () => {
    const runner = await makeRunner();
    await runner.__registerForTests({
      name: "echo",
      manifestSource: ECHO_MANIFEST,
      body: ECHO_BODY,
    });

    const result = await runner.invoke({ name: "echo", inputs: { x: 7 } });
    expect(result.status).toBe("success");
    expect(result.output).toEqual({ echo: 8 });

    const run = await store.getRun(result.runId);
    expect(run?.status).toBe("success");
    expect(run?.output).toEqual({ echo: 8 });
    expect(run?.error).toBeNull();
    expect(run?.finishedAt).toBeInstanceOf(Date);
  });

  it("records a ctx.* audit row when the skill calls a host RPC", async () => {
    const memory = makeMockMemory();
    vi.mocked(memory.recall).mockResolvedValue({
      memories: [{ content: "fact", type: "world", metadata: {} }],
    });
    const runner = await makeRunner({ memory });

    const manifest = `---
name: with-recall
description: skill that calls ctx.memory.recall
tier: wasm
inputs:
  type: object
  properties: {}
effects:
  - reads_memory
---
`;
    const body = `
async def run(inputs, ctx):
    r = await ctx.memory.recall("hello")
    return {"count": len(r["memories"])}
`;
    await runner.__registerForTests({ name: "with-recall", manifestSource: manifest, body });

    const result = await runner.invoke({ name: "with-recall", inputs: {} });
    expect(result.status).toBe("success");
    expect(result.output).toEqual({ count: 1 });

    const calls = await store.listContextCallsForRun(result.runId);
    expect(calls.map((c) => c.method)).toContain("memory.recall");
    expect(calls.find((c) => c.method === "memory.recall")?.ok).toBe(true);
  });

  it("captures a Python exception as status=error", async () => {
    const runner = await makeRunner();
    const body = `
async def run(inputs, ctx):
    raise ValueError("kaboom")
`;
    await runner.__registerForTests({
      name: "boom",
      manifestSource: ECHO_MANIFEST.replace("name: echo", "name: boom"),
      body,
    });

    const result = await runner.invoke({ name: "boom", inputs: { x: 1 } });
    expect(result.status).toBe("error");
    expect(result.error).toContain("kaboom");

    const run = await store.getRun(result.runId);
    expect(run?.status).toBe("error");
    expect(run?.output).toBeNull();
    expect(run?.error).toContain("kaboom");
  });

  it("rejects bad inputs before spawning the worker", async () => {
    const runner = await makeRunner();
    await runner.__registerForTests({
      name: "echo",
      manifestSource: ECHO_MANIFEST,
      body: ECHO_BODY,
    });

    await expect(
      runner.invoke({ name: "echo", inputs: { x: "not-an-int" } }),
    ).rejects.toBeInstanceOf(InputValidationError);

    // No skill_runs row created — the validator runs before insertRun.
    const run = await db.query.skillRuns.findFirst();
    expect(run).toBeUndefined();
  });

  it("rejects an unknown skill name", async () => {
    const runner = await makeRunner();
    await expect(runner.invoke({ name: "missing", inputs: {} })).rejects.toThrow(/not found/);
  });

  it("rejects a disabled skill", async () => {
    const runner = await makeRunner();
    const row = await runner.__registerForTests({
      name: "echo",
      manifestSource: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    await store.setSkillDisabled({ id: row.id, disabled: true });

    await expect(runner.invoke({ name: "echo", inputs: { x: 1 } })).rejects.toThrow(/disabled/);
  });

  it("public register without skillsRepoPath throws clear config error", async () => {
    const runner = await makeRunner();
    await expect(runner.register({ branch: "x" })).rejects.toThrow(/skillsRepoPath not configured/);
    await expect(runner.approveDeploy({ pendingId: "x" })).rejects.toThrow(
      /skillsRepoPath not configured/,
    );
  });

  it("__registerForTests rejects when manifest.name != params.name", async () => {
    const runner = await makeRunner();
    await expect(
      runner.__registerForTests({
        name: "different",
        manifestSource: ECHO_MANIFEST,
        body: ECHO_BODY,
      }),
    ).rejects.toThrow(/manifest.name/);
  });

  it("rejects tier:container in P3.1 (Tier 2 lands in P3.2)", async () => {
    const runner = await makeRunner();
    const containerManifest = `---
name: container-skill
description: a container-tier skill
tier: container
inputs:
  type: object
  properties: {}
---
`;
    await runner.__registerForTests({
      name: "container-skill",
      manifestSource: containerManifest,
      body: ECHO_BODY,
    });
    await expect(runner.invoke({ name: "container-skill", inputs: {} })).rejects.toThrow(
      /not supported in P3\.1/,
    );
  });

  it("two sequential invokes succeed independently (no shared state)", async () => {
    const runner = await makeRunner();
    await runner.__registerForTests({
      name: "echo",
      manifestSource: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    const a = await runner.invoke({ name: "echo", inputs: { x: 1 } });
    const b = await runner.invoke({ name: "echo", inputs: { x: 2 } });
    expect(a.output).toEqual({ echo: 2 });
    expect(b.output).toEqual({ echo: 3 });
    expect(a.runId).not.toBe(b.runId);
  });

  it("trigger=cron records correctly on the run row", async () => {
    const runner = await makeRunner();
    await runner.__registerForTests({
      name: "echo",
      manifestSource: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    const result = await runner.invoke({ name: "echo", inputs: { x: 1 }, trigger: "cron" });
    const run = await store.getRun(result.runId);
    expect(run?.trigger).toBe("cron");
  });

  it("rollback / register / approveDeploy require skillsRepoPath", async () => {
    const runner = await makeRunner();
    await expect(runner.register({ branch: "x" })).rejects.toThrow(/skillsRepoPath/);
    await expect(runner.approveDeploy({ pendingId: "x" })).rejects.toThrow(/skillsRepoPath/);
    await expect(runner.rollback({ name: "x", toGitSha: "y" })).rejects.toThrow(/skillsRepoPath/);
    // denyDeploy + deregister are pure DB updates — no git access needed.
    // deregister throws on a non-existent skill, denyDeploy is idempotent.
    await expect(
      runner.denyDeploy({ pendingId: "00000000-0000-0000-0000-000000000000" }),
    ).resolves.toBeUndefined();
    await expect(runner.deregister({ name: "x" })).rejects.toThrow(/not found/);
  });

  it("list excludes disabled skills", async () => {
    const runner = await makeRunner();
    const a = await runner.__registerForTests({
      name: "alpha",
      manifestSource: ECHO_MANIFEST.replace("name: echo", "name: alpha"),
      body: ECHO_BODY,
    });
    await runner.__registerForTests({
      name: "beta",
      manifestSource: ECHO_MANIFEST.replace("name: echo", "name: beta"),
      body: ECHO_BODY,
    });
    await store.setSkillDisabled({ id: a.id, disabled: true });
    const list = await runner.list();
    expect(list.map((s) => s.name)).toEqual(["beta"]);
  });

  it("invoke without prior register fails with the right error", async () => {
    const runner = await makeRunner();
    // Insert a skill row directly via the store, bypassing the runner's
    // source cache. Invoke should fail with "no source for skill" instead
    // of crashing — proves the cache miss path is handled.
    await store.insertSkill({
      name: "ghost",
      tier: "wasm",
      riskTier: "auto",
      effects: [],
      schedule: null,
      gitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      inputs: { type: "object", properties: {} },
      outputs: null,
    });
    await expect(runner.invoke({ name: "ghost", inputs: {} })).rejects.toThrow(/no source/);
  });

  it("input validator caches per skill (re-invoke doesn't recompile)", async () => {
    // Smoke test: 5 invokes of the same skill should not fail despite the
    // ajv cache pattern. Real cache-instrumentation lives in the impl;
    // this is a regression catcher.
    const runner = await makeRunner();
    await runner.__registerForTests({
      name: "echo",
      manifestSource: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((x) => runner.invoke({ name: "echo", inputs: { x } })),
    );
    expect(results.every((r) => r.status === "success")).toBe(true);
  });
});
