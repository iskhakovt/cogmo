import { beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { assertKind, expectOk } from "../../test/assertions.js";
import { mockFilesService } from "../../test/factories.js";
import { hashLockfileContents } from "../deps.js";
import { parseManifest } from "../manifest.js";
import { type TaskOutcome, withheldOutcome } from "../protocol.js";
import type { SkillRunServices } from "../run-as.js";
import { SkillSourceCache } from "../source-cache.js";
import type { SkillRow, SkillRunRow, SkillStore } from "../store/index.js";
import { executeRun } from "./execute-run.js";
import { dispatchToRuntime, type RuntimeConfig, type RuntimeTask } from "./runtime.js";

vi.mock("./runtime.js", () => ({ dispatchToRuntime: vi.fn() }));

const MANIFEST = `---
name: echo
description: echoes its input back
tier: wasm
inputs:
  type: object
  properties: {}
dependencies:
  - idna==3.10
---
`;
const LOCKFILE = `idna==3.10 --hash=sha256:${"0".repeat(64)}\n`;

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function cachedEntry() {
  const { manifest } = expectOk(parseManifest(MANIFEST));
  return new SkillSourceCache(undefined).put(
    "sha-1",
    { manifest, body: "" },
    { hash: hashLockfileContents(LOCKFILE), contents: LOCKFILE },
  );
}

function runtimeConfig(resolve: RuntimeConfig["resolveWasmPackages"]): RuntimeConfig {
  return {
    pyodidePackageCacheDir: "/cache",
    pyodideDistDir: "/dist",
    wasmChildrenDir: "/children",
    resolveWasmPackages: resolve,
    containerImage: "image",
    depsCacheVolumeName: undefined,
  };
}

/** A runtime that asks the gate, then reports `outcome` when it may send; withheld otherwise. */
function sendingRuntime(outcome: TaskOutcome) {
  return async (_c: RuntimeConfig, _r: unknown, task: RuntimeTask): Promise<TaskOutcome> => {
    const decision = await task.dispatch();
    return decision.kind === "send" ? outcome : withheldOutcome();
  };
}

/** A runtime that fails before its gate, as a pool, worker or populate failure does. */
function failingRuntime(outcome: TaskOutcome) {
  return async (): Promise<TaskOutcome> => outcome;
}

const SWEPT_ROW = mock<SkillRunRow>({ id: "run-1", errorKind: "host_lost" });

describe("executeRun", () => {
  const store = mock<SkillStore>();
  const resolve = vi.fn<RuntimeConfig["resolveWasmPackages"]>();
  const packages = { builtins: ["pydantic"], wheelDir: "/wheels/abc" };

  beforeEach(() => {
    store.transitionToDispatched.mockReset();
    store.transitionToExecuted.mockReset();
    store.failBeforeDispatch.mockReset();
    store.transitionToDispatched.mockResolvedValue({ kind: "dispatched" });
    store.transitionToExecuted.mockResolvedValue({ kind: "transitioned" });
    store.failBeforeDispatch.mockResolvedValue({ kind: "transitioned" });
  });

  async function execute() {
    return executeRun(
      {
        store,
        runInTx: fakeRunInTx,
        secretsStore: mock<SecretsStore>(),
        userTimezone: "UTC",
        runtime: runtimeConfig(resolve),
        ctxHttp: undefined,
      },
      {
        run: { id: "run-1", key: "skill-tool:call-1", createdAt: new Date() },
        skill: mock<SkillRow>({ name: "echo", tier: "wasm" }),
        cached: cachedEntry(),
        inputs: {},
        runAs: {
          userId: "user-1",
          profileId: "profile-1",
          service: { memory: mock<SkillRunServices["memory"]>(), files: mockFilesService() },
        },
        runtime: { kind: "wasm", packages },
      },
    );
  }

  it("dispatches with the wall clock's deadline, then records the output from dispatched", async () => {
    vi.mocked(dispatchToRuntime).mockImplementation(
      sendingRuntime({ ok: true, output: { echo: 1 } }),
    );
    const before = Date.now();

    const executed = await execute();

    expect(executed).toEqual({
      kind: "executed",
      outcome: { kind: "output", output: { echo: 1 } },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(vi.mocked(dispatchToRuntime).mock.calls[0]?.[1]).toEqual({ kind: "wasm", packages });
    // The runtime enforces the wall clock the deadline counts from.
    expect(vi.mocked(dispatchToRuntime).mock.calls[0]?.[2].wallClockS).toBe(30);
    // The task carries the run and the invocation's key, which `ctx.run()` returns.
    expect(vi.mocked(dispatchToRuntime).mock.calls[0]?.[2].run).toEqual({
      id: "run-1",
      key: "skill-tool:call-1",
    });
    const dispatched = store.transitionToDispatched.mock.calls[0]?.[1];
    // The wasm tier's 30 s wall clock plus the 60 s grace.
    expect(dispatched?.deadlineAt.getTime()).toBeGreaterThanOrEqual(before + 90_000);
    expect(dispatched?.deadlineAt.getTime()).toBeLessThanOrEqual(Date.now() + 90_000);
    expect(store.transitionToExecuted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "run-1", outcome: { kind: "output", output: { echo: 1 } } }),
    );
    expect(store.failBeforeDispatch).not.toHaveBeenCalled();
  });

  it("records a dispatched task's error with its kind; a worker's output_invalid keeps no output", async () => {
    vi.mocked(dispatchToRuntime).mockImplementation(
      sendingRuntime({ ok: false, errorKind: "output_invalid", error: "output is not JSON" }),
    );

    const executed = await execute();

    const outcome = {
      kind: "error",
      error: { kind: "output_invalid", message: "output is not JSON", output: null },
    };
    expect(executed).toEqual({ kind: "executed", outcome });
    expect(store.transitionToExecuted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "run-1", outcome }),
    );
  });

  it("records a task that failed before its gate from started, saying no skill code ran", async () => {
    vi.mocked(dispatchToRuntime).mockImplementation(
      failingRuntime({
        ok: false,
        errorKind: "dependency_unavailable",
        error: "skill_venv_failed",
      }),
    );

    const executed = await execute();

    const error = {
      kind: "dependency_unavailable",
      message: "skill_venv_failed (no skill code ran)",
    };
    expect(executed).toEqual({ kind: "executed", outcome: { kind: "error", error } });
    expect(store.transitionToDispatched).not.toHaveBeenCalled();
    expect(store.transitionToExecuted).not.toHaveBeenCalled();
    expect(store.failBeforeDispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "run-1", error }),
    );
  });

  it("returns the swept row when the sweeper finished the run before the gate", async () => {
    store.transitionToDispatched.mockResolvedValue({ kind: "swept", row: SWEPT_ROW });
    store.failBeforeDispatch.mockResolvedValue({ kind: "swept", row: SWEPT_ROW });
    vi.mocked(dispatchToRuntime).mockImplementation(sendingRuntime({ ok: true, output: 1 }));

    const executed = await execute();

    assertKind(executed, "swept");
    expect(executed.row).toBe(SWEPT_ROW);
    expect(store.transitionToExecuted).not.toHaveBeenCalled();
  });

  it("returns the swept row when the sweeper finished the run before the outcome landed", async () => {
    store.transitionToExecuted.mockResolvedValue({ kind: "swept", row: SWEPT_ROW });
    vi.mocked(dispatchToRuntime).mockImplementation(sendingRuntime({ ok: true, output: 1 }));

    const executed = await execute();

    assertKind(executed, "swept");
    expect(executed.row).toBe(SWEPT_ROW);
  });

  it("throws on an output, or a kind no runtime reports unsent, from a task never dispatched", async () => {
    vi.mocked(dispatchToRuntime).mockImplementation(failingRuntime({ ok: true, output: 1 }));
    await expect(execute()).rejects.toThrow(/returned an output for a task it never sent/);

    vi.mocked(dispatchToRuntime).mockImplementation(
      failingRuntime({ ok: false, errorKind: "skill_raised", error: "boom" }),
    );
    await expect(execute()).rejects.toThrow(/reported skill_raised for a task it never sent/);
    expect(store.failBeforeDispatch).not.toHaveBeenCalled();
  });
});
