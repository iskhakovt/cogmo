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
 * Deliberately not `--add-host host.docker.internal:host-gateway`: under
 * rootless Docker `host-gateway` resolves to the bridge gateway *inside*
 * RootlessKit's network namespace, which is not the host, so the connection is
 * refused. Testcontainers tunnels through an sshd sidecar instead — no host
 * address is involved, so one code path covers rootful, rootless and CI, and it
 * reaches loopback-bound listeners too.
 *
 * Ordering matters: `GenericContainer` consults the forwarder at *create* time
 * to inject the host mapping, so containers needing the port must be created
 * after this resolves.
 */
export async function exposeHostPort(port: number): Promise<string> {
  // Mirror + pin the forwarder's sidecar like every other image in this file;
  // upstream defaults to an unmirrored Docker Hub pull. An explicit override wins.
  process.env.SSHD_CONTAINER_IMAGE ??= "mirror.gcr.io/testcontainers/sshd:1.3.0";
  await TestContainers.exposeHostPorts(port);
  return `http://host.testcontainers.internal:${port}`;
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
