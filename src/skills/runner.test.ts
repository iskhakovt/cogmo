import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Service } from "../agent/service.js";
import type { Database, Transactor } from "../db/index.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { SandboxClient } from "../sandbox/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { mockFilesService } from "../test/factories.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { InputValidationError, mapManifestResourceLimits, SkillRunnerImpl } from "./runner.js";
import { DrizzleSkillStore } from "./store/index.js";
import { SysboxWorkerPool } from "./worker-sysbox/pool.js";

function makeMockFiles(): Service["files"] {
  return mockFilesService();
}

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleSkillStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleSkillStore();
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

function makeMockMemory(): MemoryProvider {
  const memory = mock<MemoryProvider>();
  memory.recall.mockResolvedValue({ memories: [] });
  return memory;
}

function makeMockSecrets(map: Record<string, string> = {}): SecretsStore {
  const secrets = mock<SecretsStore>();
  // getSecret is now (tx, name) — see migration to tx-first store methods.
  secrets.getSecret.mockImplementation(async (_tx, name) => map[name]);
  return secrets;
}

async function makeRunner(
  opts: { memory?: MemoryProvider; secretsStore?: SecretsStore; files?: Service["files"] } = {},
) {
  return SkillRunnerImpl.create({
    store,
    runInTx: tx,
    memory: opts.memory ?? makeMockMemory(),
    secretsStore: opts.secretsStore ?? makeMockSecrets(),
    files: opts.files ?? makeMockFiles(),
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

describe("SkillRunnerImpl", () => {
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

    const run = await tx((trx) => store.getRun(trx, result.runId));
    expect(run?.status).toBe("success");
    expect(run?.output).toEqual({ echo: 8 });
    expect(run?.error).toBeNull();
    expect(run?.finishedAt).toBeInstanceOf(Date);
    // Tier-1 (Pyodide) leaves rusage unset — the host still records
    // wall_clock_ms from the timestamps and writes null for peak memory.
    expect(run?.resourceUsage?.wallClockMs).toBeGreaterThanOrEqual(0);
    expect(run?.resourceUsage?.peakMemoryBytes).toBeNull();
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

    const calls = await tx((trx) => store.listContextCallsForRun(trx, result.runId));
    expect(calls.map((c) => c.method)).toContain("memory.recall");
    expect(calls.find((c) => c.method === "memory.recall")?.ok).toBe(true);
  });

  it("round-trips ctx.files.{write,read,list} through the Python SDK", async () => {
    const files = makeMockFiles();
    vi.mocked(files.list).mockResolvedValue([
      { path: "notes/draft.md", size: 5, lastModified: new Date("2026-04-01T00:00:00.000Z") },
    ]);
    vi.mocked(files.read).mockResolvedValue("hello");
    const runner = await makeRunner({ files });

    const manifest = `---
name: with-files
description: skill that touches ctx.files
tier: wasm
inputs:
  type: object
  properties: {}
effects:
  - reads_filesystem
  - writes_filesystem
---
`;
    const body = `
async def run(inputs, ctx):
    await ctx.files.write("notes/draft.md", "hello")
    content = await ctx.files.read("notes/draft.md")
    entries = await ctx.files.list("notes/")
    return {"content": content, "first_path": entries[0]["path"], "size": entries[0]["size"]}
`;
    await runner.__registerForTests({ name: "with-files", manifestSource: manifest, body });

    const result = await runner.invoke({ name: "with-files", inputs: {} });
    expect(result.status).toBe("success");
    expect(result.output).toEqual({
      content: "hello",
      first_path: "notes/draft.md",
      size: 5,
    });

    expect(files.write).toHaveBeenCalledWith("notes/draft.md", "hello");
    expect(files.read).toHaveBeenCalledWith("notes/draft.md");
    expect(files.list).toHaveBeenCalledWith("notes/");

    const calls = await tx((trx) => store.listContextCallsForRun(trx, result.runId));
    const methods = calls.map((c) => c.method);
    expect(methods).toContain("files.write");
    expect(methods).toContain("files.read");
    expect(methods).toContain("files.list");
  });

  it("rejects ctx.files.read when reads_filesystem is not declared", async () => {
    const files = makeMockFiles();
    const runner = await makeRunner({ files });

    const manifest = `---
name: forbidden-read
description: skill that tries ctx.files.read without the effect
tier: wasm
inputs:
  type: object
  properties: {}
---
`;
    const body = `
async def run(inputs, ctx):
    try:
        await ctx.files.read("notes/draft.md")
        return {"reached": True}
    except Exception as e:
        return {"reached": False, "kind": getattr(e, "kind", None)}
`;
    await runner.__registerForTests({ name: "forbidden-read", manifestSource: manifest, body });

    const result = await runner.invoke({ name: "forbidden-read", inputs: {} });
    expect(result.status).toBe("success");
    expect(result.output).toEqual({ reached: false, kind: "missing_effect" });
    expect(files.read).not.toHaveBeenCalled();
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

    const run = await tx((trx) => store.getRun(trx, result.runId));
    expect(run?.status).toBe("error");
    expect(run?.output).toBeNull();
    expect(run?.error).toContain("kaboom");
    // Error-path coverage of the no-rusage → null coalesce in
    // `runner.invoke`. Pyodide's worker-entry catches the exception and
    // emits a `task_result` without a `rusage` block, identical in shape
    // to the tier-2 supervisor-synthesised result (wall-clock kill,
    // SIGKILL, watchdog). A regression that swapped `?? null` for `?? 0`
    // would silently corrupt the operator-visible peak-memory column on
    // every failed run.
    expect(run?.resourceUsage?.wallClockMs).toBeGreaterThanOrEqual(0);
    expect(run?.resourceUsage?.peakMemoryBytes).toBeNull();
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
    await tx((trx) => store.setSkillDisabled(trx, { id: row.id, disabled: true }));

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

  it("rejects tier:container when no sandbox is configured", async () => {
    // Runner constructed without `sandbox` — tier-2 invocation must fail
    // fast with a clear error rather than silently no-op or hang.
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
      /no sandbox is configured/,
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
    const run = await tx((trx) => store.getRun(trx, result.runId));
    expect(run?.trigger).toBe("cron");
  });

  it("rollback / register / approveDeploy require skillsRepoPath", async () => {
    const runner = await makeRunner();
    await expect(runner.register({ branch: "x" })).rejects.toThrow(/skillsRepoPath/);
    await expect(runner.approveDeploy({ pendingId: "x" })).rejects.toThrow(/skillsRepoPath/);
    await expect(runner.rollback({ name: "x", toGitSha: "y" })).rejects.toThrow(/skillsRepoPath/);
    // denyDeploy + deregister are pure DB updates — no git access needed.
    // denyDeploy is idempotent on a missing pending id; deregister
    // returns rejected:not_found via DeregisterResult.
    await expect(
      runner.denyDeploy({ pendingId: "00000000-0000-0000-0000-000000000000" }),
    ).resolves.toBeUndefined();
    const dereg = await runner.deregister({ name: "x" });
    expect(dereg).toEqual({ kind: "rejected", name: "x", reason: "not_found" });
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
    await tx((trx) => store.setSkillDisabled(trx, { id: a.id, disabled: true }));
    const list = await runner.list();
    expect(list.map((s) => s.name)).toEqual(["beta"]);
  });

  it("enable re-activates a deregistered skill (round-trip)", async () => {
    const runner = await makeRunner();
    const row = await runner.__registerForTests({
      name: "echo",
      manifestSource: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    expect(await runner.deregister({ name: "echo" })).toEqual({
      kind: "deregistered",
      name: "echo",
    });
    expect((await runner.listAll()).find((s) => s.name === "echo")?.disabled).toBe(true);

    const result = await runner.enable({ name: "echo" });
    expect(result).toEqual({ kind: "enabled", name: "echo", gitSha: row.gitSha });
    expect((await runner.list()).map((s) => s.name)).toContain("echo");
  });

  it("enable on an already-enabled skill is idempotent", async () => {
    const runner = await makeRunner();
    const row = await runner.__registerForTests({
      name: "echo",
      manifestSource: ECHO_MANIFEST,
      body: ECHO_BODY,
    });
    const result = await runner.enable({ name: "echo" });
    expect(result).toEqual({ kind: "already_enabled", name: "echo", gitSha: row.gitSha });
  });

  it("enable rejects an unknown skill name", async () => {
    const runner = await makeRunner();
    const result = await runner.enable({ name: "nope" });
    expect(result).toEqual({ kind: "rejected", name: "nope", reason: "not_found" });
  });

  it("enable refuses when the current sha was never live (approval-gate guard)", async () => {
    // Simulate a denied first deploy: insert a disabled skill row + a single
    // skill_deploys row with status='denied' at the same sha. /enable would
    // otherwise smuggle un-approved code past the approval gate.
    const runner = await makeRunner();
    const sha = "feedfacefeedfacefeedfacefeedfacefeedface";
    const row = await tx((trx) =>
      store.insertSkill(trx, {
        name: "denied-skill",
        tier: "wasm",
        riskTier: "approve",
        effects: [],
        schedule: null,
        scheduleNextRunAt: null,
        gitSha: sha,
        inputs: { type: "object", properties: {} },
        outputs: null,
      }),
    );
    await tx((trx) => store.setSkillDisabled(trx, { id: row.id, disabled: true }));
    await tx((trx) =>
      store.insertDeploy(trx, {
        skillId: row.id,
        gitSha: sha,
        priorGitSha: null,
        riskTier: "approve",
        status: "denied",
        classifierLog: {
          classifier_version: "test",
          risk_tier: "approve",
          declared_effects: [],
          detected_effects: [],
          declared_secrets: [],
          validation_errors: [],
        },
      }),
    );

    const result = await runner.enable({ name: "denied-skill" });
    expect(result).toEqual({
      kind: "rejected",
      name: "denied-skill",
      reason: "no_live_deploy",
    });
    // Row still disabled — guard didn't accidentally flip it.
    expect((await runner.listAll()).find((s) => s.name === "denied-skill")?.disabled).toBe(true);
  });

  it("listAll includes disabled skills (sorted by name)", async () => {
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
    await tx((trx) => store.setSkillDisabled(trx, { id: a.id, disabled: true }));
    const list = await runner.listAll();
    expect(list.map((s) => ({ name: s.name, disabled: s.disabled }))).toEqual([
      { name: "alpha", disabled: true },
      { name: "beta", disabled: false },
    ]);
  });

  it("invoke without prior register fails with the right error", async () => {
    const runner = await makeRunner();
    // Insert a skill row directly via the store, bypassing the runner's
    // source cache. Invoke should fail with "no source for skill" instead
    // of crashing — proves the cache miss path is handled.
    await tx((trx) =>
      store.insertSkill(trx, {
        name: "ghost",
        tier: "wasm",
        riskTier: "auto",
        effects: [],
        schedule: null,
        scheduleNextRunAt: null,
        gitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        inputs: { type: "object", properties: {} },
        outputs: null,
      }),
    );
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

describe("UTF-8 / non-ASCII body — locks the JSON-as-Python-literal contract", () => {
  it("a skill body containing emoji and non-BMP chars round-trips through Pyodide", async () => {
    const runner = await makeRunner();
    // Body intentionally contains: emoji (non-BMP — surrogate pair),
    // accented Latin, CJK, an embedded backslash, and a newline literal.
    // If the body-inlining encoder ever drifts (e.g. someone swaps the JSON
    // encoder for one that emits `\/` or trims surrogate pairs), this test
    // catches it before the bug reaches a real skill.
    const body = `
async def run(inputs, ctx):
    return {"emoji": "\\U0001F600", "accented": "café", "cjk": "日本語", "back": "a\\\\b"}
`;
    await runner.__registerForTests({
      name: "unicode",
      manifestSource: ECHO_MANIFEST.replace("name: echo", "name: unicode"),
      body,
    });
    const r = await runner.invoke({ name: "unicode", inputs: { x: 1 } });
    expect(r.status).toBe("success");
    expect(r.output).toEqual({
      emoji: "😀",
      accented: "café",
      cjk: "日本語",
      back: "a\\b",
    });
  });
});

describe("mapManifestResourceLimits", () => {
  it("maps memory_mb to bytes and cpu_shares to cpus", () => {
    expect(mapManifestResourceLimits({ memory_mb: 1024, cpu_shares: 2, wall_clock_s: 30 })).toEqual(
      { memory_bytes: 1024 * 1024 * 1024, cpus: 2 },
    );
  });

  it("maps cpu_shares alone — regression: was silently dropped before", () => {
    expect(mapManifestResourceLimits({ cpu_shares: 3 })).toEqual({ cpus: 3 });
  });

  it("maps memory_mb alone", () => {
    expect(mapManifestResourceLimits({ memory_mb: 512 })).toEqual({
      memory_bytes: 512 * 1024 * 1024,
    });
  });

  it("returns an empty object when the manifest declares no resources", () => {
    expect(mapManifestResourceLimits(undefined)).toEqual({});
    expect(mapManifestResourceLimits({})).toEqual({});
  });

  it("ignores wall_clock_s — that's threaded as a separate runOnSysboxContainer arg", () => {
    expect(mapManifestResourceLimits({ wall_clock_s: 60 })).toEqual({});
  });
});

// Race + lifecycle invariants for the lazy tier-2 pool. Spies on
// `SysboxWorkerPool.create` (named import is bound to the module's
// class object, so the spy propagates to runner.ts's call site
// without further plumbing) so we can control timing without
// spinning up real sysbox containers.
const TIER2_MANIFEST = `---
name: tier2-test
description: tier-2 test skill
tier: container
inputs:
  type: object
  properties: {}
---
`;
const TIER2_BODY = `
def main(inputs, ctx):
    return {"ok": True}
`;

describe("SkillRunnerImpl tier-2 pool lifecycle", () => {
  let createSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createSpy = vi.spyOn(SysboxWorkerPool, "create");
  });
  afterEach(() => {
    createSpy.mockRestore();
  });

  function makeFakePool() {
    return {
      invoke: vi.fn(async () => ({ ok: true, output: { x: 7 }, workerReusable: true })),
      dispose: vi.fn(async () => undefined),
    } as unknown as SysboxWorkerPool;
  }

  async function makeTier2Runner() {
    const runner = await SkillRunnerImpl.create({
      store,
      runInTx: tx,
      memory: makeMockMemory(),
      secretsStore: makeMockSecrets(),
      files: makeMockFiles(),
      user: { id: "user-1", timezone: "UTC" },
      memoryBankId: "bank-1",
      sandbox: mock<SandboxClient>(),
    });
    await runner.__registerForTests({
      name: "tier2-test",
      manifestSource: TIER2_MANIFEST,
      body: TIER2_BODY,
    });
    return runner;
  }

  it("dedupes concurrent first-callers — one SysboxWorkerPool.create across N parallel invokes", async () => {
    const fakePool = makeFakePool();
    let resolveCreate: (p: SysboxWorkerPool) => void = () => {};
    createSpy.mockImplementation(() => new Promise<SysboxWorkerPool>((r) => (resolveCreate = r)));
    const runner = await makeTier2Runner();

    // Three invokes fire before the pool finishes constructing — all
    // three should queue behind one in-flight `#poolPromise`.
    const pending = [
      runner.invoke({ name: "tier2-test", inputs: {} }),
      runner.invoke({ name: "tier2-test", inputs: {} }),
      runner.invoke({ name: "tier2-test", inputs: {} }),
    ];
    // Drain microtasks so each invoke reaches `#ensurePool`.
    await new Promise<void>((r) => setImmediate(r));

    expect(createSpy).toHaveBeenCalledTimes(1);

    resolveCreate(fakePool);
    const results = await Promise.all(pending);

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(fakePool.invoke).toHaveBeenCalledTimes(3);
    for (const r of results) {
      expect(r.status).toBe("success");
    }
  });

  it("clears #poolPromise on init failure — next invoke retries with a fresh create", async () => {
    const fakePool = makeFakePool();
    createSpy
      .mockRejectedValueOnce(new Error("daytona unreachable"))
      .mockResolvedValueOnce(fakePool);
    const runner = await makeTier2Runner();

    // First invoke fails because pool create rejects. The current
    // tier-2 path surfaces the failure as a thrown exception (no
    // outer try/catch wraps `pool.invoke`); the contract under test
    // here is just that the failure happens AND that the second
    // invoke retries — not the shape of the failure surface.
    await expect(runner.invoke({ name: "tier2-test", inputs: {} })).rejects.toThrow(
      /daytona unreachable/,
    );

    // Second invoke triggers a fresh create — pool resolves and the
    // skill runs through normally. Pins the "no permanent poisoning"
    // contract.
    const ok = await runner.invoke({ name: "tier2-test", inputs: {} });
    expect(ok.status).toBe("success");
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(fakePool.invoke).toHaveBeenCalledTimes(1);
  });

  it("invoke after shutdown throws and never calls SysboxWorkerPool.create", async () => {
    const runner = await makeTier2Runner();
    // No pool was ever created. Shutdown still flips `#disposed` so a
    // post-shutdown tier-2 invoke can't lazy-spawn one.
    await runner.shutdown();

    await expect(runner.invoke({ name: "tier2-test", inputs: {} })).rejects.toThrow(
      /pool requested after shutdown/,
    );
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("shutdown awaits in-flight pool init and disposes the late-arriving pool", async () => {
    const fakePool = makeFakePool();
    let resolveCreate: (p: SysboxWorkerPool) => void = () => {};
    createSpy.mockImplementation(() => new Promise<SysboxWorkerPool>((r) => (resolveCreate = r)));
    const runner = await makeTier2Runner();

    // Kick off pool init via an invoke — it will hang on the
    // controlled create promise.
    const inflight = runner.invoke({ name: "tier2-test", inputs: {} });
    inflight.catch(() => undefined); // suppress unhandled-rejection — we await it explicitly below
    await new Promise<void>((r) => setImmediate(r));
    expect(createSpy).toHaveBeenCalledTimes(1);

    // Begin shutdown while pool init is still pending. Shutdown
    // awaits the in-flight promise rather than tearing down empty.
    let shutdownResolved = false;
    const shutdownPromise = runner.shutdown().then(() => {
      shutdownResolved = true;
    });
    await new Promise<void>((r) => setImmediate(r));
    // Shutdown is blocked on the pending create — proves the await.
    expect(shutdownResolved).toBe(false);

    // Resolve create; shutdown should now run pool.dispose.
    resolveCreate(fakePool);
    await shutdownPromise;
    await inflight;

    expect(shutdownResolved).toBe(true);
    expect(fakePool.dispose).toHaveBeenCalledTimes(1);
  });
});
