import { beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { expectOk } from "../../test/assertions.js";
import { mockFilesService } from "../../test/factories.js";
import { hashLockfileContents } from "../deps.js";
import { parseManifest } from "../manifest.js";
import type { SkillRunServices } from "../run-as.js";
import { SkillSourceCache } from "../source-cache.js";
import type { SkillRow, SkillStore } from "../store/index.js";
import { executeRun } from "./execute-run.js";
import { dispatchToRuntime, type RuntimeConfig } from "./runtime.js";

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

describe("executeRun", () => {
  const store = mock<SkillStore>();
  const resolve = vi.fn<RuntimeConfig["resolveWasmPackages"]>();
  const packages = { builtins: ["pydantic"], wheelDir: "/wheels/abc" };

  beforeEach(() => {
    store.transitionToExecuted.mockReset();
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
        run: { id: "run-1", createdAt: new Date() },
        skill: mock<SkillRow>(),
        cached: cachedEntry(),
        inputs: {},
        runAs: {
          userId: "user-1",
          service: { memory: mock<SkillRunServices["memory"]>(), files: mockFilesService() },
        },
        runtime: { kind: "wasm", packages },
      },
    );
  }

  it("runs a wasm run with the packages its runtime carries, resolving none itself", async () => {
    vi.mocked(dispatchToRuntime).mockResolvedValue({ ok: true, output: { echo: 1 } });

    const outcome = await execute();

    expect(outcome).toEqual({ kind: "output", output: { echo: 1 } });
    expect(resolve).not.toHaveBeenCalled();
    expect(vi.mocked(dispatchToRuntime).mock.calls[0]?.[1]).toEqual({ kind: "wasm", packages });
    expect(store.transitionToExecuted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "run-1", outcome }),
    );
  });

  it("records the runtime's error as the run's outcome", async () => {
    vi.mocked(dispatchToRuntime).mockResolvedValue({ ok: false, error: "ValueError: boom" });

    const outcome = await execute();

    expect(outcome).toEqual({ kind: "error", error: "ValueError: boom" });
    expect(store.transitionToExecuted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "run-1", outcome }),
    );
  });
});
