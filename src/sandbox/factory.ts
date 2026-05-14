import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import { DaytonaSandboxClient } from "./daytona/index.js";
import type { DockerFacade } from "./docker-facade.js";
import type { SandboxClient } from "./index.js";
import type { CogmoSocketProxy } from "./proxy/index.js";
import type { SandboxRuntime } from "./runtime.js";
import type { SandboxStore } from "./store/index.js";
import { LocalDockerSandboxClient } from "./supervisor.js";

const log = logger.child({ component: "sandbox.factory" });

/**
 * Backend selector — discriminated by `backend`. Bootstrap picks one based
 * on `SANDBOX_BACKEND` env (default `local-docker`) and constructs the
 * matching deps; the factory just dispatches.
 *
 * Local-Docker requires the host stack (Docker daemon, sysbox runtime,
 * proxy, askpass bind-mount root). Daytona requires a SecretsStore so
 * the API key (stored as `daytona_api_key`) can be decrypted at boot;
 * the SDK URL defaults to Daytona Cloud.
 */
export type SandboxBackendOptions =
  | {
      backend: "local-docker";
      docker: DockerFacade;
      store: SandboxStore;
      runInTx: Transactor;
      runtime: SandboxRuntime;
      instanceId: string;
      proxy?: CogmoSocketProxy;
      askpassBaseDir?: string;
    }
  | {
      backend: "daytona";
      /**
       * Resolved Daytona API key. Bootstrap fetches this from the
       * encrypted `secrets` table (key `daytona_api_key`) before calling
       * the factory — keeping the factory free of `Transactor` /
       * `SecretsStore` deps that the local-Docker branch doesn't need.
       */
      apiKey: string;
      instanceId: string;
      /** Optional override; defaults to Daytona Cloud (`https://app.daytona.io/api`). */
      apiUrl?: string;
      organizationId?: string;
    };

/**
 * Construct a sandbox client for the chosen backend. Throws on
 * misconfigured deps (e.g. Daytona key absent from the secrets table).
 */
export async function createSandboxBackend(opts: SandboxBackendOptions): Promise<SandboxClient> {
  if (opts.backend === "local-docker") {
    const client = await LocalDockerSandboxClient.create({
      docker: opts.docker,
      store: opts.store,
      runInTx: opts.runInTx,
      runtime: opts.runtime,
      instanceId: opts.instanceId,
      ...(opts.proxy && { proxy: opts.proxy }),
      ...(opts.askpassBaseDir && { askpassBaseDir: opts.askpassBaseDir }),
    });
    return client;
  }
  if (opts.backend === "daytona") {
    log.info(
      { apiUrl: opts.apiUrl ?? "https://app.daytona.io/api" },
      "initializing Daytona sandbox backend",
    );
    return DaytonaSandboxClient.create({
      apiKey: opts.apiKey,
      instanceId: opts.instanceId,
      ...(opts.apiUrl && { apiUrl: opts.apiUrl }),
      ...(opts.organizationId && { organizationId: opts.organizationId }),
    });
  }
  // Exhaustiveness — TS narrows `opts` to never if every branch is handled.
  const _exhaustive: never = opts;
  throw new Error(`unknown sandbox backend: ${(_exhaustive as { backend: string }).backend}`);
}
