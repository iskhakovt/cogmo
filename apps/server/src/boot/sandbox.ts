/**
 * Stage 2: the sandbox client, its instance row, and the background passes
 * boot starts on it; and the client `cogmo skills` builds without them.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import Docker from "dockerode";
import { ok } from "neverthrow";
import { match } from "ts-pattern";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { DAYTONA_API_KEY_SECRET } from "../sandbox/daytona/auth.js";
import { DAYTONA_CAPABILITIES } from "../sandbox/daytona/client.js";
import { createSandboxBackend, type SandboxBackendOptions } from "../sandbox/factory.js";
import {
  CogmoSocketProxy,
  type SandboxCapabilities,
  type SandboxClient,
  type SessionSandbox,
} from "../sandbox/index.js";
import { managedBindSources } from "../sandbox/managed-binds.js";
import type { SandboxRuntime } from "../sandbox/runtime.js";
import { LOCAL_DOCKER_CAPABILITIES } from "../sandbox/supervisor.js";
import {
  type PublishedGatesBundle,
  type PublishGatesBundleDeps,
  publishGatesBundle,
  releaseGatesBundle,
} from "../skills/publish-gates-bundle.js";
import { DEFAULT_RESOURCE_LIMITS as SKILLS_DEFAULT_RESOURCE_LIMITS } from "../skills/worker-sysbox/host.js";
import { describeError } from "../util/describe-error.js";
import { checkDirWritable } from "./checks.js";
import { DEFAULT_CODING_RESOURCE_LIMITS } from "./limits.js";
import { scheduleSandboxImageWarm } from "./sandbox-image-warm.js";
import { type BootstrapOptions, type CoreDeps, NO_SANDBOX, type SandboxDeps } from "./stages.js";

/** The backend configuration stage 2 selects from: `env`'s. */
type SandboxConfig = Pick<
  typeof env,
  "SANDBOX_BACKEND" | "SANDBOX_RUNTIME" | "DAYTONA_API_URL" | "DAYTONA_ORGANIZATION_ID"
>;

/** The backend stage 2's selection picks, or why it picks none. */
type SandboxBackendChoice =
  | { backend: "none"; reason: "runtime_unset" | "daytona_key_absent" }
  | { backend: "local-docker"; runtime: SandboxRuntime }
  | { backend: "daytona"; apiKey: string };

/**
 * Stage 2's backend selection, which `cogmo skills` shares. The sandbox is
 * opt-in by backend: `local-docker` (the default) requires `SANDBOX_RUNTIME`,
 * and `daytona` requires `daytona_api_key` in the encrypted secrets table.
 * No silent fallback.
 */
async function selectSandboxBackend(
  core: Pick<CoreDeps, "runInTx" | "secretsStore">,
  config: SandboxConfig,
): Promise<SandboxBackendChoice> {
  return match(config.SANDBOX_BACKEND)
    .returnType<Promise<SandboxBackendChoice>>()
    .with("local-docker", async () =>
      config.SANDBOX_RUNTIME
        ? { backend: "local-docker", runtime: config.SANDBOX_RUNTIME }
        : { backend: "none", reason: "runtime_unset" },
    )
    .with("daytona", async () => {
      const apiKey = await core.runInTx((trx) =>
        core.secretsStore.getSecret(trx, DAYTONA_API_KEY_SECRET),
      );
      return apiKey
        ? { backend: "daytona", apiKey }
        : { backend: "none", reason: "daytona_key_absent" };
    })
    .exhaustive();
}

/**
 * Fire-and-forget orphan reaping. The per-minute sandbox reaper (local-docker)
 * and per-task TTL deletes (both backends) cover ongoing orphans; the boot-
 * time pass only matters for containers labelled with a *prior* instance id
 * that the periodic reaper would also catch on its next tick. Deferring it
 * keeps `cogmo serve` startup independent of how many orphan containers the
 * daemon happens to be carrying.
 */
export function scheduleReconcileCrashedInstances(client: SandboxClient, instanceId: string): void {
  const backendLabel = client.backendId;
  void client.reconcileCrashedInstances(instanceId).then(
    ({ orphansReaped }) => {
      if (orphansReaped > 0) {
        logger.warn(
          { orphansReaped, backendLabel },
          "reaped orphan sandboxes from prior instance(s)",
        );
      }
    },
    (err: unknown) => {
      logger.error(
        { err, instanceId, backendLabel },
        "background reconcileCrashedInstances failed",
      );
    },
  );
}

/**
 * Stage 2: sandbox client + crash-instance reconciliation. Inserts a row
 * into `cogmo_instances` (local-docker backend) so other Cogmo processes
 * can see this instance is live, then schedules an asynchronous pass that
 * reaps any container labeled with a dead instance id and then closes those
 * instance rows, so the reaper's orphan pass retries what the pass could not
 * kill. The reaping is fire-and-forget — see
 * `scheduleReconcileCrashedInstances`. Only `cogmo serve` should call this
 * stage, and only one per database — running it from a one-shot CLI, or from
 * a second live process, reaps the live `cogmo serve`'s coding-task
 * containers and closes its instance row, after which the orphan pass kills
 * every container it creates (no liveness check on other instance rows).
 *
 * Returns `NO_SANDBOX` (all-null) when the configured backend is
 * unavailable: `local-docker` requires `SANDBOX_RUNTIME`; `daytona`
 * requires `daytona_api_key` in the encrypted secrets table.
 *
 * Whatever the backend, it first finds the release's gates bundle and fails
 * the boot without it; with a backend, it publishes the bundle under
 * `SANDBOX_GATES_DIR` for the skills repo's coding sessions (design/skills.md
 * → The gates in verify → Delivery).
 */
export async function bootstrapSandbox(
  core: CoreDeps,
  opts: BootstrapOptions = {},
): Promise<SandboxDeps> {
  const gatesSource = await releaseGatesBundle(import.meta.url);
  // Test-only injection — see `BootstrapOptions.sandboxClientOverride`
  // for shape + intent. `sandboxDocker` stays null because the override
  // may not be a Docker-based backend; the reaper Inngest function is
  // local-docker-specific (queries the daemon via dockerode) and skips
  // registration when `sandboxDocker === null`.
  if (opts.sandboxClientOverride) {
    const sandbox = opts.sandboxClientOverride;
    // No daemon to ask which directories its containers bind.
    const gatesBundle = await publishGates(gatesSource, NOTHING_BOUND);
    const sandboxInstanceId = randomUUID();
    scheduleReconcileCrashedInstances(sandbox, sandboxInstanceId);
    logger.info(
      { backendId: sandbox.backendId, instanceId: sandboxInstanceId },
      "sandbox client override active (test-only)",
    );
    return {
      sandbox,
      codingSandbox: sandbox,
      sandboxInstanceId,
      sandboxDocker: null,
      gatesBundle,
    };
  }
  // Both backends are coding-capable: local-docker via host-bind-mount
  // worktrees, daytona via git-as-transport (`cogmo/run/<task-id>` push
  // → sandbox-side clone). `codingSandbox` is the same handle as
  // `sandbox` whenever a backend is configured; the orchestrator
  // branches on `capabilities.workingTreeTransport`, not backend
  // identity. The split exists because the reaper Inngest function
  // remains local-docker-specific (queries the Docker daemon).
  return match(await selectSandboxBackend(core, env))
    .returnType<Promise<SandboxDeps>>()
    .with({ backend: "none" }, async ({ reason }) => {
      match(reason)
        .with("runtime_unset", () =>
          logger.info(
            "SANDBOX_RUNTIME unset — sandbox module disabled (coding-delegation unavailable)",
          ),
        )
        .with("daytona_key_absent", () =>
          logger.warn(
            `SANDBOX_BACKEND=daytona but \`${DAYTONA_API_KEY_SECRET}\` secret is absent — sandbox disabled. Run \`cogmo setup\` to add it.`,
          ),
        )
        .exhaustive();
      return NO_SANDBOX;
    })
    .with({ backend: "local-docker" }, ({ runtime }) =>
      bootstrapLocalDocker(core, runtime, gatesSource),
    )
    .with({ backend: "daytona" }, ({ apiKey }) => bootstrapDaytona(apiKey, gatesSource))
    .exhaustive();
}

/** The bind sources of a backend whose sessions bind nothing on this host. */
const NOTHING_BOUND: PublishGatesBundleDeps["boundSources"] = async () => ok(new Set<string>());

/**
 * Publish the release's gates bundle, from `sourceDir`, under
 * `SANDBOX_GATES_DIR`, checked writable first as the askpass root is.
 */
async function publishGates(
  sourceDir: string,
  boundSources: PublishGatesBundleDeps["boundSources"],
): Promise<PublishedGatesBundle> {
  await checkDirWritable(env.SANDBOX_GATES_DIR, "SANDBOX_GATES_DIR");
  return publishGatesBundle({ boundSources }, { sourceDir, root: env.SANDBOX_GATES_DIR });
}

/**
 * Stage 2 on Local-Docker: the gates bundle, the instance row, the socket
 * proxy, and the crash reconcile.
 */
async function bootstrapLocalDocker(
  core: CoreDeps,
  runtime: SandboxRuntime,
  gatesSource: string,
): Promise<SandboxDeps> {
  // Fail-fast: both dirs receive per-task writes (proxy sockets,
  // askpass material) and a permission problem on either surfaces as
  // a generic EACCES on the first task otherwise. Askpass is also
  // needed on the daytona backend (host-side `provisionAskpass` writes
  // the files that `askpass-upload.ts` then uploads via the SDK), so
  // that probe runs in both branches.
  await Promise.all([
    checkDirWritable(env.SANDBOX_PROXY_SOCKET_DIR, "SANDBOX_PROXY_SOCKET_DIR"),
    checkDirWritable(env.SANDBOX_ASKPASS_DIR, "SANDBOX_ASKPASS_DIR"),
  ]);
  const docker = new Docker();
  // A graceful stop leaves its containers running until the reaper's orphan
  // pass, still binding their release's bundle, so that one stays.
  const gatesBundle = await publishGates(gatesSource, () => managedBindSources(docker));
  const instance = await core.runInTx((trx) =>
    core.sandboxStore.insertInstance(trx, { host: hostname(), pid: process.pid }),
  );
  const proxy = await CogmoSocketProxy.create({
    socketDir: env.SANDBOX_PROXY_SOCKET_DIR,
    hostDockerSocket: env.SANDBOX_HOST_DOCKER_SOCKET,
  });
  const localDocker = await createSandboxBackend({
    backend: "local-docker",
    docker,
    store: core.sandboxStore,
    runInTx: core.runInTx,
    runtime,
    instanceId: instance.id,
    proxy,
    askpassBaseDir: env.SANDBOX_ASKPASS_DIR,
  });
  const codingSandbox = localDocker;
  scheduleReconcileCrashedInstances(localDocker, instance.id);
  logger.info(
    {
      runtime,
      instanceId: instance.id,
      proxySocketDir: env.SANDBOX_PROXY_SOCKET_DIR,
    },
    "local-docker sandbox initialized",
  );
  return {
    sandbox: localDocker,
    codingSandbox,
    sandboxInstanceId: instance.id,
    sandboxDocker: docker,
    gatesBundle,
  };
}

/** Stage 2 on Daytona: the gates bundle, the client, the crash reconcile and the image warm. */
async function bootstrapDaytona(apiKey: string, gatesSource: string): Promise<SandboxDeps> {
  // Host-side: `provisionAskpass` writes the per-task files that
  // `askpass-upload.ts` then ships into the daytona sandbox.
  await checkDirWritable(env.SANDBOX_ASKPASS_DIR, "SANDBOX_ASKPASS_DIR");
  // Each session's create, and a resume after a deploy, uploads the bundle
  // from here; nothing binds it.
  const gatesBundle = await publishGates(gatesSource, NOTHING_BOUND);
  // Daytona needs a process-run id for label-stamping orphan
  // detection in a future reconcile pass. We don't insert into
  // sandbox_instances (that table FK's to local-docker
  // `containers`) — just generate one for symmetry with the
  // local-docker `cogmo.instance` label.
  const sandboxInstanceId = randomUUID();
  const sandbox = await createSandboxBackend({
    backend: "daytona",
    apiKey,
    instanceId: sandboxInstanceId,
    ...(env.DAYTONA_API_URL && { apiUrl: env.DAYTONA_API_URL }),
    ...(env.DAYTONA_ORGANIZATION_ID && { organizationId: env.DAYTONA_ORGANIZATION_ID }),
  });
  scheduleReconcileCrashedInstances(sandbox, sandboxInstanceId);
  // Fire-and-forget snapshot prewarm so the first coding-delegation /
  // container skill task doesn't pay the multi-minute Daytona
  // snapshot-build latency in its own request budget. Concurrent
  // task arrivals share the in-flight promise via
  // `ensureImagePresent`'s memoisation. Failures evict the cache so
  // the task path retries on its own.
  // Pair each image with its consumer's limits — baked into the
  // snapshot at warm time; the `daytona.create({ snapshot })` path
  // has no per-session override.
  scheduleSandboxImageWarm(sandbox, [
    { image: env.COGMO_DEVBASE_IMAGE, resourceLimits: DEFAULT_CODING_RESOURCE_LIMITS },
    { image: env.COGMO_SKILLS_IMAGE, resourceLimits: SKILLS_DEFAULT_RESOURCE_LIMITS },
  ]);
  logger.info(
    {
      instanceId: sandboxInstanceId,
      apiUrl: env.DAYTONA_API_URL ?? "https://app.daytona.io/api",
    },
    "daytona sandbox initialized",
  );
  return { sandbox, codingSandbox: sandbox, sandboxInstanceId, sandboxDocker: null, gatesBundle };
}

/** The process whose `SIGINT` or `SIGTERM` closes the CLI sandbox's instance row. */
interface CliExitSignals {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code: number): void;
}

/** What `bootstrapCliSandbox` reads and runs. */
export interface CliSandboxOptions {
  /** The backend configuration: `env`, which stage 2 selects from too. */
  config: SandboxConfig;
  /** Builds the backend's client: `createSandboxBackend`. */
  createBackend(opts: SandboxBackendOptions): Promise<SandboxClient>;
  signals: CliExitSignals;
}

/** The sandbox `cogmo skills` builds (design/skills.md → Register-time CPython checks → The CLI's sandbox). */
export interface CliSandbox {
  /**
   * Where register's and approve's sessions run, built when the first of
   * them starts; null when no backend is configured.
   */
  sandbox: SessionSandbox | null;
  /** Close the instance row the client inserted, if it did. Idempotent; never rejects. */
  close(): Promise<void>;
}

/**
 * The sandbox client `cogmo skills` builds: stage 2's backend selection, and
 * none of `bootstrapSandbox`'s serve-only work. It schedules no crash
 * reconcile, which would close serve's instance row and reap serve's
 * containers; registers no reaper; warms no image; and creates no Docker
 * socket proxy or askpass directory, so its sessions mount no Docker socket.
 * The client is built when register or approve first creates a session, so
 * `list` and the other commands never touch a sandbox. On Local-Docker,
 * building it inserts this process's own `cogmo_instances` row, which keeps
 * serve's orphan pass off its sessions; `close` closes it when the command
 * ends, and a `SIGINT` or `SIGTERM` closes it before the process exits.
 */
export async function bootstrapCliSandbox(
  core: Pick<CoreDeps, "runInTx" | "secretsStore" | "sandboxStore">,
  opts: CliSandboxOptions,
): Promise<CliSandbox> {
  return match(await selectSandboxBackend(core, opts.config))
    .returnType<CliSandbox>()
    .with({ backend: "none" }, () => ({ sandbox: null, close: async () => {} }))
    .with({ backend: "local-docker" }, ({ runtime }) => localDockerCliSandbox(core, runtime, opts))
    .with({ backend: "daytona" }, ({ apiKey }) => ({
      sandbox: lazySessionSandbox("daytona", DAYTONA_CAPABILITIES, () =>
        opts.createBackend({
          backend: "daytona",
          apiKey,
          instanceId: randomUUID(),
          ...(opts.config.DAYTONA_API_URL && { apiUrl: opts.config.DAYTONA_API_URL }),
          ...(opts.config.DAYTONA_ORGANIZATION_ID && {
            organizationId: opts.config.DAYTONA_ORGANIZATION_ID,
          }),
        }),
      ),
      close: async () => {},
    }))
    .exhaustive();
}

/**
 * The CLI's Local-Docker client. Building it inserts the process's own
 * records first: its `cogmo_instances` row, which labels every container the
 * client creates. This is also the seam for the `[proposed]` `serve_instances`
 * row (design/skills.md → Data model), which no table holds yet.
 */
function localDockerCliSandbox(
  core: Pick<CoreDeps, "runInTx" | "sandboxStore">,
  runtime: SandboxRuntime,
  opts: CliSandboxOptions,
): CliSandbox {
  /** The open instance row, and the close every caller awaits once one starts. */
  let row: { id: string; closing: Promise<void> | null } | null = null;
  const closeRow = async (id: string): Promise<void> => {
    try {
      await core.runInTx((tx) => core.sandboxStore.closeInstance(tx, id));
    } catch (e) {
      logger.warn(
        { instanceId: id, err: describeError(e) },
        "cli sandbox: instance row not closed",
      );
    }
  };
  // A signal during the command's own close awaits the same transaction, so
  // the process never exits with the row open.
  const close = (): Promise<void> => {
    if (row === null) return Promise.resolve();
    row.closing ??= closeRow(row.id);
    return row.closing;
  };
  let listening = false;
  const closeOnSignals = (): void => {
    if (listening) return;
    listening = true;
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      opts.signals.once(signal, () => {
        void close().finally(() => opts.signals.exit(code));
      });
    }
  };
  const sandbox = lazySessionSandbox("local-docker", LOCAL_DOCKER_CAPABILITIES, async () => {
    const instance = await core.runInTx((tx) =>
      core.sandboxStore.insertInstance(tx, { host: hostname(), pid: process.pid }),
    );
    row = { id: instance.id, closing: null };
    closeOnSignals();
    try {
      return await opts.createBackend({
        backend: "local-docker",
        docker: new Docker(),
        store: core.sandboxStore,
        runInTx: core.runInTx,
        runtime,
        instanceId: instance.id,
      });
    } catch (e) {
      // No container carries the row's id yet; the next attempt inserts its own.
      await close();
      row = null;
      throw e;
    }
  });
  return { sandbox, close };
}

/**
 * A {@link SessionSandbox} whose client `build` makes on first use; a build
 * that fails is retried by the next call.
 */
function lazySessionSandbox(
  backendId: string,
  capabilities: Readonly<SandboxCapabilities>,
  build: () => Promise<SandboxClient>,
): SessionSandbox {
  let client: Promise<SandboxClient> | undefined;
  const built = (): Promise<SandboxClient> => {
    client ??= build().catch((e: unknown) => {
      client = undefined;
      throw e;
    });
    return client;
  };
  return {
    backendId,
    capabilities,
    ensureImagePresent: async (image, limits) => (await built()).ensureImagePresent(image, limits),
    create: async (spec) => (await built()).create(spec),
    delete: async (session) => (await built()).delete(session),
  };
}
