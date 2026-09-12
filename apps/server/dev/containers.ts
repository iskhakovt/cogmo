/**
 * Shared testcontainers factories — used by both e2e test setup and dev-infra script.
 *
 * Each factory returns a configured (but not started) container.
 * The caller starts them in the right order and manages lifecycle.
 */

import { GenericContainer, type StartedNetwork, TestContainers, Wait } from "testcontainers";

/**
 * Publish a host port to every container created afterwards, and return the
 * base URL they reach it on.
 *
 * Not `--add-host host.docker.internal:host-gateway`: under rootless Docker that
 * gateway sits inside RootlessKit's namespace, not on the host. The sshd sidecar
 * tunnels instead, so no host address is involved and loopback-bound listeners
 * work too.
 *
 * Call before creating any container that needs the port — the mapping is
 * injected at create time, and one created too early silently gets none. The
 * check is per-process, so worker-fork containers get none either. Sidecar image
 * is pinned in `vitest.config.ts`. Teardown does not stop the forwarder — cleanup
 * is Ryuk's, and it has been seen to outlive a run even with Ryuk enabled.
 */
export async function exposeHostPort(port: number): Promise<string> {
  await TestContainers.exposeHostPorts(port);
  return `http://host.testcontainers.internal:${port}`;
}

/**
 * Remove a test network, detaching whatever is still attached to it first.
 *
 * A tier stops the containers it tracks, but not everything on the network is
 * its own: Testcontainers starts the port forwarder itself and joins it to
 * each user-defined network, and sandbox containers are created by the
 * supervisor through dockerode. Docker refuses to remove a network that still
 * has endpoints, and the 403 surfaces from teardown — failing the run even
 * when every test passed, which reads as a green suite with a red job.
 *
 * Disconnecting is deliberately not the same as stopping: a forwarder shared
 * with a concurrently-running tier must keep running, it just has no business
 * holding this network open. Best-effort throughout — anything already gone is
 * the outcome we wanted.
 */
export async function stopNetwork(network: StartedNetwork): Promise<void> {
  const { default: Docker } = await import("dockerode");
  const handle = new Docker().getNetwork(network.getId());
  try {
    const inspected: { Containers?: Record<string, unknown> } = await handle.inspect();
    for (const containerId of Object.keys(inspected.Containers ?? {})) {
      await handle.disconnect({ Container: containerId, Force: true }).catch(() => {});
    }
  } catch {
    // Network already gone, or the daemon will not describe it. Fall through:
    // the stop below is guarded too, so there is nothing to decide here.
  }
  // Guarded as well, and that is the point of the function: a disconnect that
  // silently failed above, or a network already removed, must not put the 403
  // back. Teardown failing is indistinguishable from the suite failing in the
  // job's exit code, so cleanup warns and moves on.
  await network.stop().catch((err) => {
    console.warn("stopNetwork: removing the test network failed", err);
  });
}

export function postgres(network: StartedNetwork) {
  return new GenericContainer("mirror.gcr.io/pgvector/pgvector:pg18")
    .withNetwork(network)
    .withNetworkAliases("postgres")
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: "cogmo",
      POSTGRES_DB: "cogmo",
      POSTGRES_HOST_AUTH_METHOD: "trust",
    })
    .withCopyFilesToContainer([
      { source: "./scripts/init-db.sql", target: "/docker-entrypoint-initdb.d/init.sql" },
    ])
    .withWaitStrategy(Wait.forSuccessfulCommand("pg_isready -U cogmo"))
    .withStartupTimeout(60_000);
}

export function redis(network: StartedNetwork) {
  return new GenericContainer("mirror.gcr.io/library/redis:8-alpine")
    .withNetwork(network)
    .withNetworkAliases("redis")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forSuccessfulCommand("redis-cli ping"))
    .withStartupTimeout(30_000);
}

/** `appUrl` pointing at the host must come from `exposeHostPort()` — there is no
 * `host.docker.internal` mapping on these containers. */
export function inngest(network: StartedNetwork, opts?: { appUrl?: string }) {
  const cmd = ["inngest", "dev", "--host", "0.0.0.0", "--port", "8288", "--no-discovery"];
  if (opts?.appUrl) {
    cmd.push("-u", opts.appUrl);
  }
  return new GenericContainer("mirror.gcr.io/inngest/inngest:v1.41.1")
    .withNetwork(network)
    .withNetworkAliases("inngest")
    .withExposedPorts(8288, 8289)
    .withCommand(cmd)
    .withWaitStrategy(Wait.forHttp("/health", 8288))
    .withStartupTimeout(60_000);
}

export function minio(network: StartedNetwork) {
  return new GenericContainer("cgr.dev/chainguard/minio:latest")
    .withNetwork(network)
    .withNetworkAliases("minio")
    .withExposedPorts(9000)
    .withEnvironment({
      MINIO_ROOT_USER: "minioadmin",
      MINIO_ROOT_PASSWORD: "minioadmin",
    })
    .withCommand(["server", "/data"])
    .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000))
    .withStartupTimeout(30_000);
}

/**
 * Create the files bucket in MinIO. Idempotent — a reused MinIO volume (dev's
 * `withReuse`) already has it, so BucketAlreadyOwnedByYou / BucketAlreadyExists
 * is swallowed; any other failure propagates.
 */
export async function ensureFilesBucket(s3Endpoint: string): Promise<void> {
  const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({
    endpoint: s3Endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
  });
  try {
    await s3.send(new CreateBucketCommand({ Bucket: "cogmo-files" }));
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
  } finally {
    s3.destroy();
  }
}

export function hindsight(
  network: StartedNetwork,
  opts: {
    apiKey: string;
    /** A host address here must come from `exposeHostPort()`. */
    baseUrl?: string;
  },
) {
  const env: Record<string, string> = {
    HINDSIGHT_API_LLM_PROVIDER: "anthropic",
    HINDSIGHT_API_LLM_API_KEY: opts.apiKey,
  };
  if (opts.baseUrl) env.HINDSIGHT_API_LLM_BASE_URL = opts.baseUrl;

  // API-only image — same runtime as the full `hindsight` image but without
  // the Control Plane web UI (which Cogmo never talks to). Pinned within
  // `cogmo.hindsightCompat`: a floating `latest` drifts past the range and
  // trips the boot version check.
  return new GenericContainer("ghcr.io/vectorize-io/hindsight-api:0.9.1")
    .withNetwork(network)
    .withNetworkAliases("hindsight")
    .withExposedPorts(8888)
    .withEnvironment(env)
    .withWaitStrategy(Wait.forHttp("/health", 8888))
    .withStartupTimeout(300_000);
}

/**
 * Slim Hindsight — API-only, no local ML models, external LLM + embeddings.
 * ~400MB image, ~5s startup. No Control Plane UI (Cogmo doesn't use it).
 *
 * Reranking defaults to `rrf` — the RRF-fused retrieval order with no
 * cross-encoder, so no model, no network call, no API key, and an ordering that
 * depends only on the recorded fixtures. That is what every test caller wants.
 * `openrouter` is the escape hatch for checking a production-shaped reranker by
 * hand; it makes live calls, so nothing hermetic may pass it.
 * See design/memory.md → Reranking.
 */
export function hindsightSlim(
  network: StartedNetwork,
  opts: {
    llmProvider?: "openai" | "anthropic";
    llmBaseUrl: string;
    llmApiKey: string;
    llmModel: string;
    embeddingsBaseUrl: string;
    embeddingsApiKey: string;
    embeddingsModel: string;
    rerankerProvider?: "rrf" | "openrouter";
    rerankerApiKey?: string;
    rerankerModel?: string;
    rerankerBaseUrl?: string;
  },
) {
  const llmProvider = opts.llmProvider ?? "openai";
  const rerankerProvider = opts.rerankerProvider ?? "rrf";

  const env: Record<string, string> = {
    HINDSIGHT_API_LLM_PROVIDER: llmProvider,
    HINDSIGHT_API_LLM_BASE_URL: opts.llmBaseUrl,
    HINDSIGHT_API_LLM_API_KEY: opts.llmApiKey,
    HINDSIGHT_API_LLM_MODEL: opts.llmModel,
    HINDSIGHT_API_EMBEDDINGS_PROVIDER: "openai",
    HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL: opts.embeddingsBaseUrl,
    HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY: opts.embeddingsApiKey,
    HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL: opts.embeddingsModel,
    HINDSIGHT_API_RERANKER_PROVIDER: rerankerProvider,
    HINDSIGHT_API_SKIP_LLM_VERIFICATION: "true",
  };

  if (rerankerProvider === "openrouter") {
    if (opts.rerankerApiKey) env.HINDSIGHT_API_RERANKER_OPENROUTER_API_KEY = opts.rerankerApiKey;
    if (opts.rerankerModel) env.HINDSIGHT_API_RERANKER_OPENROUTER_MODEL = opts.rerankerModel;
    if (opts.rerankerBaseUrl) env.HINDSIGHT_API_RERANKER_OPENROUTER_BASE_URL = opts.rerankerBaseUrl;
  }

  // Pin version — floating `latest-slim` breaks llmock fixtures when Hindsight
  // changes its LLM request format. Update version + re-record fixtures together.
  return new GenericContainer("ghcr.io/vectorize-io/hindsight-api:0.9.1-slim")
    .withNetwork(network)
    .withNetworkAliases("hindsight")
    .withExposedPorts(8888)
    .withEnvironment(env)
    .withWaitStrategy(Wait.forHttp("/health", 8888))
    .withStartupTimeout(300_000);
}

/**
 * Gitea container — local GitHub-shaped git host for the slice 4 verify
 * orchestrator integration test. Real `git push`; the REST endpoint
 * (Gitea's `/api/v1/repos/{owner}/{repo}/pulls`) is **not** exercised —
 * Cogmo's octokit calls are intercepted at the fetch layer in the test.
 *
 * `INSTALL_LOCK=true` skips the web-installer first-run wizard so the
 * API is usable immediately. SQLite + Gitea's default paths under
 * `/data/gitea/` keep this single-container — no second DB instance.
 */
export function gitea(network: StartedNetwork) {
  return new GenericContainer("docker.gitea.com/gitea:1.27.2")
    .withNetwork(network)
    .withNetworkAliases("gitea")
    .withExposedPorts(3000)
    .withEnvironment({
      GITEA__security__INSTALL_LOCK: "true",
    })
    .withWaitStrategy(Wait.forHttp("/api/v1/version", 3000))
    .withStartupTimeout(60_000);
}

interface ContainerEndpoint {
  getHost(): string;
  getMappedPort(p: number): number;
}

/** Get mapped URLs from started containers. */
export function getUrls(containers: {
  postgres: ContainerEndpoint;
  inngest: ContainerEndpoint;
  hindsight?: ContainerEndpoint;
  minio?: ContainerEndpoint;
}) {
  return {
    databaseUrl: `postgresql://cogmo@${containers.postgres.getHost()}:${containers.postgres.getMappedPort(5432)}/cogmo`,
    inngestBaseUrl: `http://${containers.inngest.getHost()}:${containers.inngest.getMappedPort(8288)}`,
    ...(containers.hindsight && {
      hindsightUrl: `http://${containers.hindsight.getHost()}:${containers.hindsight.getMappedPort(8888)}`,
    }),
    ...(containers.minio && {
      s3Endpoint: `http://${containers.minio.getHost()}:${containers.minio.getMappedPort(9000)}`,
    }),
  };
}
