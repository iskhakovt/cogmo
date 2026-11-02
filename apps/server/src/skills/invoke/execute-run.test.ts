import { err, ok } from "neverthrow";
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

function runtimeConfig(resolve: RuntimeConfig["resolveTier1Packages"]): RuntimeConfig {
  return {
    pyodidePackageCacheDir: "/cache",
    pyodideDistDir: "/dist",
    tier1ChildrenDir: "/children",
    resolveTier1Packages: resolve,
    tier2Image: "image",
    depsCacheVolumeName: undefined,
  };
}

describe("executeRun", () => {
  const store = mock<SkillStore>();

  beforeEach(() => {
    store.transitionToExecuted.mockReset();
  });

  async function execute(resolve: RuntimeConfig["resolveTier1Packages"]) {
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
        runtime: { kind: "wasm" },
      },
    );
  }

  it("fails a tier-1 run whose packages cannot be made available, and forks no child", async () => {
    const outcome = await execute(async () =>
      err({ kind: "prefetch_failed", message: "cdn down" }),
    );

    expect(outcome).toEqual({
      kind: "error",
      error: "tier1_packages_unavailable: prefetch_failed: cdn down",
    });
    expect(dispatchToRuntime).not.toHaveBeenCalled();
    expect(store.transitionToExecuted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "run-1", outcome }),
    );
  });

  it("fails a tier-1 run whose built-in fails Pyodide's pinned sha256, naming the file", async () => {
    const outcome = await execute(async () =>
      err({
        kind: "builtin_integrity",
        fileName: "micropip-0.11.1-py3-none-any.whl",
        message: "the prefetched file hashes to sha256:aa",
      }),
    );

    expect(outcome).toEqual({
      kind: "error",
      error:
        "tier1_packages_unavailable: builtin_integrity: micropip-0.11.1-py3-none-any.whl: the prefetched file hashes to sha256:aa",
    });
    expect(dispatchToRuntime).not.toHaveBeenCalled();
  });

  it("hands a tier-1 run the packages resolved for its lockfile", async () => {
    vi.mocked(dispatchToRuntime).mockResolvedValue({ ok: true, output: { echo: 1 } });
    const packages = { builtins: ["pydantic"], wheelDir: "/wheels/abc" };
    const resolve = vi.fn<RuntimeConfig["resolveTier1Packages"]>(async () => ok(packages));

    const outcome = await execute(resolve);

    expect(outcome).toEqual({ kind: "output", output: { echo: 1 } });
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ contents: LOCKFILE }));
    expect(vi.mocked(dispatchToRuntime).mock.calls[0]?.[7]).toEqual(packages);
  });
});
