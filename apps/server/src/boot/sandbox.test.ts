import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";
import { ok } from "neverthrow";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transaction, Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import { DAYTONA_API_KEY_SECRET } from "../sandbox/daytona/auth.js";
import { DAYTONA_CAPABILITIES } from "../sandbox/daytona/client.js";
import type { SandboxBackendOptions } from "../sandbox/factory.js";
import type { SandboxClient, SandboxSession, SessionSpec } from "../sandbox/index.js";
import { managedBindSources } from "../sandbox/managed-binds.js";
import { DrizzleSandboxStore } from "../sandbox/store/index.js";
import { cogmoInstances } from "../sandbox/store/schema.js";
import { LOCAL_DOCKER_CAPABILITIES } from "../sandbox/supervisor.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../secrets/encryption.js";
import { DrizzleSecretsStore } from "../secrets/store/index.js";
import {
  type PublishGatesBundleDeps,
  publishGatesBundle,
  releaseGatesBundle,
} from "../skills/publish-gates-bundle.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import {
  bootstrapCliSandbox,
  bootstrapSandbox,
  scheduleReconcileCrashedInstances,
} from "./sandbox.js";
import { type CoreDeps, NO_SANDBOX } from "./stages.js";

// `bootstrapSandbox` reads `env`; each test of it sets the keys it needs on
// this copy of the real one.
const testEnv: Record<string, unknown> = vi.hoisted(() => ({}));
vi.mock("../env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../env.js")>();
  Object.assign(testEnv, actual.env);
  return { ...actual, env: testEnv };
});
vi.mock("../skills/publish-gates-bundle.js", () => ({
  releaseGatesBundle: vi.fn(),
  publishGatesBundle: vi.fn(),
}));
vi.mock("../sandbox/managed-binds.js", () => ({ managedBindSources: vi.fn() }));

describe("scheduleReconcileCrashedInstances", () => {
  it("logs a warn with backendLabel + orphansReaped when reconcile returns a non-zero count", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      const client = mock<SandboxClient>({ backendId: "test-backend" });
      const reconcileResult = Promise.resolve({ orphansReaped: 3 });
      client.reconcileCrashedInstances.mockReturnValue(reconcileResult);

      scheduleReconcileCrashedInstances(client, "inst-1");

      // Drain the helper's `.then` microtask — `reconcileResult` is already
      // resolved, so a single await on it lets the registered callback fire
      // before our continuation observes the spy.
      await reconcileResult;
      await Promise.resolve();

      expect(client.reconcileCrashedInstances).toHaveBeenCalledWith("inst-1");
      expect(warnSpy).toHaveBeenCalledWith(
        { orphansReaped: 3, backendLabel: "test-backend" },
        "reaped orphan sandboxes from prior instance(s)",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("stays silent when reconcile reports zero orphans", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      const client = mock<SandboxClient>({ backendId: "test-backend" });
      const reconcileResult = Promise.resolve({ orphansReaped: 0 });
      client.reconcileCrashedInstances.mockReturnValue(reconcileResult);

      scheduleReconcileCrashedInstances(client, "inst-2");

      await reconcileResult;
      await Promise.resolve();

      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs an error and does not throw when reconcile rejects", async () => {
    const errorSpy = vi.spyOn(logger, "error");
    try {
      const client = mock<SandboxClient>({ backendId: "test-backend" });
      const reconcileErr = new Error("daemon unreachable");
      // Pre-handle the rejection inline so the bare-promise rejection
      // doesn't get logged by vitest's `unhandledRejection` listener — the
      // helper attaches its own onRejected handler downstream of this one,
      // but the test holds the mock-returned promise directly and needs
      // its own safety net.
      const reconcileResult = Promise.reject(reconcileErr);
      reconcileResult.catch(() => null);
      client.reconcileCrashedInstances.mockReturnValue(reconcileResult);

      expect(() => scheduleReconcileCrashedInstances(client, "inst-3")).not.toThrow();

      await reconcileResult.catch(() => null);
      await Promise.resolve();

      expect(errorSpy).toHaveBeenCalledWith(
        { err: reconcileErr, instanceId: "inst-3", backendLabel: "test-backend" },
        "background reconcileCrashedInstances failed",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("bootstrapCliSandbox", () => {
  let db: Database;
  let tx: Transactor;
  let closeDb: () => Promise<void>;
  let core: Parameters<typeof bootstrapCliSandbox>[0];

  beforeAll(async () => {
    ({ db, tx, close: closeDb } = await createTestDatabase());
    const key = deriveMasterKey(parseMasterKey(generateMasterKey()), "cogmo/secrets-at-rest/v1");
    core = {
      runInTx: tx,
      sandboxStore: new DrizzleSandboxStore(),
      secretsStore: new DrizzleSecretsStore(key),
    };
  });

  afterEach(async () => {
    await truncateAll(db);
  });

  afterAll(async () => {
    await closeDb();
  });

  const LOCAL_DOCKER = {
    SANDBOX_BACKEND: "local-docker",
    SANDBOX_RUNTIME: "runc",
    DAYTONA_API_URL: undefined,
    DAYTONA_ORGANIZATION_ID: undefined,
  } as const;
  const DAYTONA = {
    SANDBOX_BACKEND: "daytona",
    SANDBOX_RUNTIME: undefined,
    DAYTONA_API_URL: "https://daytona.test/api",
    DAYTONA_ORGANIZATION_ID: undefined,
  } as const;
  const SPEC: SessionSpec = {
    taskId: "019d0000-0000-7000-8000-000000000001",
    image: "cogmo-skills:test",
    resourceLimits: { cpus: 1, memory_bytes: 512 * 1024 * 1024, pids: 256 },
    expiresAt: new Date(0),
    network: "none",
  };

  /** A process's signals: each listener `once` registers, and the codes `exit` was called with. */
  function fakeSignals() {
    const listeners = new Map<string, () => void>();
    const exits: number[] = [];
    return {
      listeners,
      exits,
      signals: {
        once: (signal: string, listener: () => void) => {
          listeners.set(signal, listener);
        },
        exit: (code: number) => {
          exits.push(code);
        },
      },
    };
  }

  function backendBuilding(client: SandboxClient) {
    return vi.fn<(opts: SandboxBackendOptions) => Promise<SandboxClient>>(async () => client);
  }

  async function instances() {
    return db.select().from(cogmoInstances);
  }

  it.each([
    {
      name: "local-docker without SANDBOX_RUNTIME",
      config: { ...LOCAL_DOCKER, SANDBOX_RUNTIME: undefined },
    },
    { name: "daytona without daytona_api_key", config: DAYTONA },
  ])("has no sandbox for $name", async ({ config }) => {
    const createBackend = backendBuilding(mock<SandboxClient>());

    const cli = await bootstrapCliSandbox(core, {
      config,
      createBackend,
      signals: fakeSignals().signals,
    });

    expect(cli.sandbox).toBeNull();
    await cli.close();
    expect(createBackend).not.toHaveBeenCalled();
    expect(await instances()).toEqual([]);
  });

  it("builds nothing and inserts no row until a session first needs the client", async () => {
    const { signals, listeners } = fakeSignals();
    const createBackend = backendBuilding(mock<SandboxClient>());

    const cli = await bootstrapCliSandbox(core, { config: LOCAL_DOCKER, createBackend, signals });
    await cli.close();

    expect(cli.sandbox?.capabilities).toEqual(LOCAL_DOCKER_CAPABILITIES);
    // Shared with every Local-Docker client, so nothing a caller does to it reaches the others.
    expect(Object.isFrozen(cli.sandbox?.capabilities)).toBe(true);
    expect(cli.sandbox?.backendId).toBe("local-docker");
    expect(createBackend).not.toHaveBeenCalled();
    expect(await instances()).toEqual([]);
    expect(listeners.size).toBe(0);
  });

  it("inserts its own instance row on Local-Docker when first used, closes it on exit, and reconciles nothing", async () => {
    const client = mock<SandboxClient>();
    const session = mock<SandboxSession>();
    client.create.mockResolvedValue(session);
    const createBackend = backendBuilding(client);
    const cli = await bootstrapCliSandbox(core, {
      config: LOCAL_DOCKER,
      createBackend,
      signals: fakeSignals().signals,
    });
    const sandbox = expectDefined(cli.sandbox, "the CLI's sandbox");

    await sandbox.ensureImagePresent("cogmo-skills:test");
    expect(await sandbox.create(SPEC)).toBe(session);
    await sandbox.delete(session);

    const [row] = await instances();
    expect(row).toMatchObject({ pid: process.pid, stoppedAt: null });
    expect(createBackend).toHaveBeenCalledTimes(1);
    // No socket proxy or askpass directory: a CLI session mounts no Docker socket.
    expect(createBackend).toHaveBeenCalledWith({
      backend: "local-docker",
      docker: expect.anything(),
      store: core.sandboxStore,
      runInTx: tx,
      runtime: "runc",
      instanceId: expectDefined(row, "instance row").id,
    });
    expect(client.create).toHaveBeenCalledWith(SPEC);
    expect(client.delete).toHaveBeenCalledWith(session);
    expect(client.reconcileCrashedInstances).not.toHaveBeenCalled();

    await cli.close();
    await cli.close();

    const [closed] = await instances();
    expect(closed?.stoppedAt).toBeInstanceOf(Date);
  });

  it.each([
    { signal: "SIGINT", code: 130 },
    { signal: "SIGTERM", code: 143 },
  ])(
    "closes the instance row on $signal before the process exits $code",
    async ({ signal, code }) => {
      const { signals, listeners, exits } = fakeSignals();
      const cli = await bootstrapCliSandbox(core, {
        config: LOCAL_DOCKER,
        createBackend: backendBuilding(mock<SandboxClient>()),
        signals,
      });
      await expectDefined(cli.sandbox, "the CLI's sandbox").ensureImagePresent("cogmo-skills:test");

      expectDefined(listeners.get(signal), `a ${signal} listener`)();

      await vi.waitFor(() => expect(exits).toEqual([code]));
      const [closed] = await instances();
      expect(closed?.stoppedAt).toBeInstanceOf(Date);
    },
  );

  it("holds a signal during the command's close until the row is closed, closing it once", async () => {
    const { signals, listeners, exits } = fakeSignals();
    const sandboxStore = new DrizzleSandboxStore();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closeInstance = vi.spyOn(sandboxStore, "closeInstance");
    closeInstance.mockImplementation(async (trx, id) => {
      await gate;
      await DrizzleSandboxStore.prototype.closeInstance.call(sandboxStore, trx, id);
    });
    const cli = await bootstrapCliSandbox(
      { ...core, sandboxStore },
      { config: LOCAL_DOCKER, createBackend: backendBuilding(mock<SandboxClient>()), signals },
    );
    await expectDefined(cli.sandbox, "the CLI's sandbox").ensureImagePresent("cogmo-skills:test");

    const closing = cli.close();
    expectDefined(listeners.get("SIGTERM"), "a SIGTERM listener")();
    // Let the signal's close run as far as it can while the command's holds the transaction.
    await new Promise((resolve) => setImmediate(resolve));

    expect(exits).toEqual([]);
    release();
    await closing;
    await vi.waitFor(() => expect(exits).toEqual([143]));
    const [closed] = await instances();
    expect(closed?.stoppedAt).toBeInstanceOf(Date);
    expect(closeInstance).toHaveBeenCalledTimes(1);
  });

  it("closes the row of a client that did not build, and a retry inserts its own", async () => {
    const createBackend = vi
      .fn<(opts: SandboxBackendOptions) => Promise<SandboxClient>>()
      .mockRejectedValueOnce(new Error("SANDBOX_RUNTIME=runc requires Docker runtime 'runc'"))
      .mockResolvedValue(mock<SandboxClient>());
    const cli = await bootstrapCliSandbox(core, {
      config: LOCAL_DOCKER,
      createBackend,
      signals: fakeSignals().signals,
    });
    const sandbox = expectDefined(cli.sandbox, "the CLI's sandbox");

    await expect(sandbox.create(SPEC)).rejects.toThrow("requires Docker runtime");
    const [failed] = await instances();
    expect(failed?.stoppedAt).toBeInstanceOf(Date);

    await sandbox.create(SPEC);
    const open = (await instances()).filter((i) => i.stoppedAt === null);
    expect(open).toHaveLength(1);
    expect(createBackend).toHaveBeenCalledTimes(2);
  });

  it("logs an instance row it cannot close, and resolves", async () => {
    const warn = vi.spyOn(logger, "warn");
    const sandboxStore = new DrizzleSandboxStore();
    vi.spyOn(sandboxStore, "closeInstance").mockRejectedValue(new Error("database gone"));
    const cli = await bootstrapCliSandbox(
      { ...core, sandboxStore },
      {
        config: LOCAL_DOCKER,
        createBackend: backendBuilding(mock<SandboxClient>()),
        signals: fakeSignals().signals,
      },
    );
    try {
      await expectDefined(cli.sandbox, "the CLI's sandbox").ensureImagePresent("cogmo-skills:test");

      await expect(cli.close()).resolves.toBeUndefined();

      const [row] = await instances();
      expect(warn).toHaveBeenCalledWith(
        { instanceId: expectDefined(row, "instance row").id, err: "database gone" },
        "cli sandbox: instance row not closed",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("builds a Daytona client with the stored key on first use, inserting no instance row", async () => {
    await tx((trx) =>
      core.secretsStore.putSecret(trx, { name: DAYTONA_API_KEY_SECRET, plaintext: "dtn-key" }),
    );
    const { signals, listeners } = fakeSignals();
    const createBackend = backendBuilding(mock<SandboxClient>());
    const cli = await bootstrapCliSandbox(core, { config: DAYTONA, createBackend, signals });
    const sandbox = expectDefined(cli.sandbox, "the CLI's sandbox");

    await sandbox.ensureImagePresent("cogmo-skills:test");

    expect(sandbox.capabilities).toEqual(DAYTONA_CAPABILITIES);
    expect(Object.isFrozen(sandbox.capabilities)).toBe(true);
    expect(createBackend).toHaveBeenCalledWith({
      backend: "daytona",
      apiKey: "dtn-key",
      instanceId: expect.any(String),
      apiUrl: "https://daytona.test/api",
    });
    expect(await instances()).toEqual([]);
    expect(listeners.size).toBe(0);
  });
});

describe("bootstrapSandbox's gates bundle", () => {
  /** What the stand-in publish throws once it has recorded what it was given. */
  const PUBLISH_STOPPED = new Error("the stand-in publish stops the boot here");
  const FAKE_TX = { __mockTx: true } as never;
  const fakeRunInTx: Transactor = <T>(cb: (trx: Transaction) => Promise<T>) => cb(FAKE_TX);
  let dirs: string;
  let baseline: Record<string, unknown>;

  beforeAll(() => {
    baseline = { ...testEnv };
  });

  beforeEach(async () => {
    dirs = await mkdtemp(join(tmpdir(), "cogmo-boot-sandbox-"));
    Object.assign(testEnv, {
      SANDBOX_PROXY_SOCKET_DIR: join(dirs, "sockets"),
      SANDBOX_ASKPASS_DIR: join(dirs, "askpass"),
      SANDBOX_GATES_DIR: join(dirs, "gates"),
    });
    vi.mocked(releaseGatesBundle).mockResolvedValue("/release/skills-gates");
    vi.mocked(publishGatesBundle).mockImplementation(async () => {
      throw PUBLISH_STOPPED;
    });
  });

  afterEach(async () => {
    for (const key of Object.keys(testEnv)) delete testEnv[key];
    Object.assign(testEnv, baseline);
    vi.mocked(releaseGatesBundle).mockReset();
    vi.mocked(publishGatesBundle).mockReset();
    vi.mocked(managedBindSources).mockReset();
    await rm(dirs, { recursive: true, force: true });
  });

  function core(daytonaKey: string | undefined): CoreDeps {
    const secretsStore = mock<DrizzleSecretsStore>();
    secretsStore.getSecret.mockResolvedValue(daytonaKey);
    return mock<CoreDeps>({ runInTx: fakeRunInTx, secretsStore });
  }

  /** The `boundSources` the boot handed the publish. */
  function publishedWith(): PublishGatesBundleDeps["boundSources"] {
    return expectDefined(vi.mocked(publishGatesBundle).mock.calls[0], "the publish")[0]
      .boundSources;
  }

  it("fails the boot without the release's bundle, before any backend is chosen", async () => {
    Object.assign(testEnv, { SANDBOX_BACKEND: "local-docker", SANDBOX_RUNTIME: undefined });
    vi.mocked(releaseGatesBundle).mockRejectedValue(
      new Error("the release's gates bundle lacks x"),
    );

    await expect(bootstrapSandbox(core(undefined))).rejects.toThrow(
      "the release's gates bundle lacks x",
    );
    const moduleUrl = expectDefined(vi.mocked(releaseGatesBundle).mock.calls[0], "the check")[0];
    expect(moduleUrl).toMatch(/\/boot\/sandbox\.ts$/);
  });

  it("publishes nothing with no backend configured", async () => {
    Object.assign(testEnv, { SANDBOX_BACKEND: "local-docker", SANDBOX_RUNTIME: undefined });

    expect(await bootstrapSandbox(core(undefined))).toEqual(NO_SANDBOX);
    expect(releaseGatesBundle).toHaveBeenCalledTimes(1);
    expect(publishGatesBundle).not.toHaveBeenCalled();
  });

  it("checks SANDBOX_GATES_DIR is writable before it publishes", async () => {
    const file = join(dirs, "a-file");
    await writeFile(file, "");
    testEnv.SANDBOX_GATES_DIR = join(file, "gates");

    await expect(
      bootstrapSandbox(core(undefined), { sandboxClientOverride: mock<SandboxClient>() }),
    ).rejects.toThrow(`SANDBOX_GATES_DIR=${join(file, "gates")} is not writable`);
    expect(publishGatesBundle).not.toHaveBeenCalled();
  });

  it("asks the daemon which directories Local-Docker's containers bind", async () => {
    Object.assign(testEnv, { SANDBOX_BACKEND: "local-docker", SANDBOX_RUNTIME: "runc" });
    const bound = ok<ReadonlySet<string>, string>(new Set(["/var/lib/cogmo/gates/d1"]));
    vi.mocked(managedBindSources).mockResolvedValue(bound);

    await expect(bootstrapSandbox(core(undefined))).rejects.toBe(PUBLISH_STOPPED);

    expect(vi.mocked(publishGatesBundle).mock.calls[0]?.[1]).toEqual({
      sourceDir: "/release/skills-gates",
      root: join(dirs, "gates"),
    });
    expect(await publishedWith()()).toBe(bound);
    expect(vi.mocked(managedBindSources).mock.calls).toEqual([[expect.any(Docker)]]);
  });

  it("publishes for Daytona, whose sessions bind nothing", async () => {
    Object.assign(testEnv, { SANDBOX_BACKEND: "daytona" });

    await expect(bootstrapSandbox(core("dtn-key"))).rejects.toBe(PUBLISH_STOPPED);

    expect((await publishedWith()())._unsafeUnwrap()).toEqual(new Set());
    expect(managedBindSources).not.toHaveBeenCalled();
  });

  it("publishes for the test override, binding nothing", async () => {
    await expect(
      bootstrapSandbox(core(undefined), { sandboxClientOverride: mock<SandboxClient>() }),
    ).rejects.toBe(PUBLISH_STOPPED);

    expect((await publishedWith()())._unsafeUnwrap()).toEqual(new Set());
    expect(managedBindSources).not.toHaveBeenCalled();
  });
});
