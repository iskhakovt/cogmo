/**
 * Stage 2: the sandbox client, its instance row, and the background passes
 * boot starts on it.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import Docker from "dockerode";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { DAYTONA_API_KEY_SECRET } from "../sandbox/daytona/auth.js";
import { createSandboxBackend } from "../sandbox/factory.js";
import { CogmoSocketProxy, type SandboxClient } from "../sandbox/index.js";
import { DEFAULT_RESOURCE_LIMITS as SKILLS_DEFAULT_RESOURCE_LIMITS } from "../skills/worker-sysbox/host.js";
import { checkDirWritable } from "./checks.js";
import { DEFAULT_CODING_RESOURCE_LIMITS } from "./coding.js";
import { scheduleSandboxImageWarm } from "./sandbox-image-warm.js";
import { type BootstrapOptions, type CoreDeps, NO_SANDBOX, type SandboxDeps } from "./stages.js";

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
 * reaps any container labeled with a dead instance id. The reaping is
 * fire-and-forget — see `scheduleReconcileCrashedInstances`. Only `cogmo
 * serve` should call this stage — running it from a one-shot CLI reaps the
 * live `cogmo serve`'s coding-task containers (no liveness check on other
 * instance rows).
 *
 * Returns `NO_SANDBOX` (all-null) when the configured backend is
 * unavailable: `local-docker` requires `SANDBOX_RUNTIME`; `daytona`
 * requires `daytona_api_key` in the encrypted secrets table.
 */
export async function bootstrapSandbox(
  core: CoreDeps,
  opts: BootstrapOptions = {},
): Promise<SandboxDeps> {
  // Test-only injection — see `BootstrapOptions.sandboxClientOverride`
  // for shape + intent. `sandboxDocker` stays null because the override
  // may not be a Docker-based backend; the reaper Inngest function is
  // local-docker-specific (queries the daemon via dockerode) and skips
  // registration when `sandboxDocker === null`.
  if (opts.sandboxClientOverride) {
    const sandbox = opts.sandboxClientOverride;
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
    };
  }
  // Sandbox is opt-in by backend:
  //   - `SANDBOX_BACKEND=local-docker` (default) requires `SANDBOX_RUNTIME`;
  //     unset = sandbox disabled (coding-delegation features fail at call
  //     time with a clear error). No silent fallback.
  //   - `SANDBOX_BACKEND=daytona` requires `daytona_api_key` in the
  //     encrypted secrets table; missing = sandbox disabled.
  // Both backends are coding-capable: local-docker via host-bind-mount
  // worktrees, daytona via git-as-transport (`cogmo/run/<task-id>` push
  // → sandbox-side clone). `codingSandbox` is the same handle as
  // `sandbox` whenever a backend is configured; the orchestrator
  // branches on `capabilities.workingTreeTransport`, not backend
  // identity. The split exists because the reaper Inngest function
  // remains local-docker-specific (queries the Docker daemon).
  if (env.SANDBOX_BACKEND === "local-docker") {
    if (!env.SANDBOX_RUNTIME) {
      logger.info(
        "SANDBOX_RUNTIME unset — sandbox module disabled (coding-delegation unavailable)",
      );
      return NO_SANDBOX;
    }
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
      runtime: env.SANDBOX_RUNTIME,
      instanceId: instance.id,
      proxy,
      askpassBaseDir: env.SANDBOX_ASKPASS_DIR,
    });
    const codingSandbox = localDocker;
    scheduleReconcileCrashedInstances(localDocker, instance.id);
    logger.info(
      {
        runtime: env.SANDBOX_RUNTIME,
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
    };
  }
  if (env.SANDBOX_BACKEND === "daytona") {
    const apiKey = await core.runInTx((trx) =>
      core.secretsStore.getSecret(trx, DAYTONA_API_KEY_SECRET),
    );
    if (!apiKey) {
      logger.warn(
        `SANDBOX_BACKEND=daytona but \`${DAYTONA_API_KEY_SECRET}\` secret is absent — sandbox disabled. Run \`cogmo setup\` to add it.`,
      );
      return NO_SANDBOX;
    }
    // Host-side: `provisionAskpass` writes the per-task files that
    // `askpass-upload.ts` then ships into the daytona sandbox.
    await checkDirWritable(env.SANDBOX_ASKPASS_DIR, "SANDBOX_ASKPASS_DIR");
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
    // skills tier-2 task doesn't pay the multi-minute Daytona
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
    return { sandbox, codingSandbox: sandbox, sandboxInstanceId, sandboxDocker: null };
  }
  return NO_SANDBOX;
}
