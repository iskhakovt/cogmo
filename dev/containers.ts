/**
 * Shared testcontainers factories — used by both e2e test setup and dev-infra script.
 *
 * Each factory returns a configured (but not started) container.
 * The caller starts them in the right order and manages lifecycle.
 */

import { OllamaContainer } from "@testcontainers/ollama";
import { GenericContainer, type StartedNetwork, Wait } from "testcontainers";

export const OLLAMA_MODEL = "qwen2.5:3b";

export function postgres(network: StartedNetwork) {
  return new GenericContainer("pgvector/pgvector:pg18")
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
  return new GenericContainer("redis:7-alpine")
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
  return new GenericContainer("inngest/inngest")
    .withNetwork(network)
    .withNetworkAliases("inngest")
    .withExposedPorts(8288, 8289)
    .withExtraHosts([{ host: "host.docker.internal", ipAddress: "host-gateway" }])
    .withCommand(cmd)
    .withWaitStrategy(Wait.forHttp("/health", 8288))
    .withStartupTimeout(60_000);
}

export function minio(network: StartedNetwork) {
  return new GenericContainer("minio/minio:latest")
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

export function ollama(network: StartedNetwork) {
  return new OllamaContainer("ollama/ollama:latest")
    .withNetwork(network)
    .withNetworkAliases("ollama");
}

export function hindsight(
  network: StartedNetwork,
  llmProvider: "ollama" | "anthropic",
  opts?: {
    apiKey?: string;
    baseUrl?: string;
  },
) {
  const env: Record<string, string> = {};

  if (llmProvider === "ollama") {
    env.HINDSIGHT_API_LLM_PROVIDER = "ollama";
    env.HINDSIGHT_API_LLM_MODEL = OLLAMA_MODEL;
    env.HINDSIGHT_API_LLM_BASE_URL = opts?.baseUrl ?? "http://ollama:11434/v1";
    env.HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS = "16000";
  } else {
    env.HINDSIGHT_API_LLM_PROVIDER = "anthropic";
    if (opts?.apiKey) env.HINDSIGHT_API_LLM_API_KEY = opts.apiKey;
    if (opts?.baseUrl) env.HINDSIGHT_API_LLM_BASE_URL = opts.baseUrl;
  }

  // API-only image — same runtime as the full `hindsight` image but without
  // the Control Plane web UI (which Cogmo never talks to). Migrations and
  // schema setup run in the API process, so dropping CP is safe.
  return new GenericContainer("ghcr.io/vectorize-io/hindsight-api:latest")
    .withNetwork(network)
    .withNetworkAliases("hindsight")
    .withExposedPorts(8888)
    .withExtraHosts([{ host: "host.docker.internal", ipAddress: "host-gateway" }])
    .withEnvironment(env)
    .withWaitStrategy(Wait.forHttp("/health", 8888))
    .withStartupTimeout(300_000);
}

/**
 * Slim Hindsight — API-only, no local ML models, external LLM + embeddings + reranker.
 * ~400MB image, ~5s startup. No Control Plane UI (Cogmo doesn't use it).
 * Patched config/cross_encoder for zerank base URL support.
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
    rerankerProvider?: "rrf" | "zeroentropy";
    rerankerApiKey?: string;
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

  if (rerankerProvider === "zeroentropy") {
    if (opts.rerankerApiKey) env.HINDSIGHT_API_RERANKER_ZEROENTROPY_API_KEY = opts.rerankerApiKey;
    if (opts.rerankerBaseUrl)
      env.HINDSIGHT_API_RERANKER_ZEROENTROPY_BASE_URL = opts.rerankerBaseUrl;
  }

  // Pin version — floating `latest-slim` breaks llmock fixtures when Hindsight
  // changes its LLM request format. Update version + re-record fixtures together.
  return new GenericContainer("ghcr.io/vectorize-io/hindsight-api:0.5.1-slim")
    .withNetwork(network)
    .withNetworkAliases("hindsight")
    .withExposedPorts(8888)
    .withExtraHosts([{ host: "host.docker.internal", ipAddress: "host-gateway" }])
    .withEnvironment(env)
    .withWaitStrategy(Wait.forHttp("/health", 8888))
    .withStartupTimeout(300_000);
}

/** Pull a model in a started Ollama container. */
export async function pullModel(
  ollamaContainer: Awaited<ReturnType<typeof OllamaContainer.prototype.start>>,
  model: string,
): Promise<void> {
  console.log(`Pulling ${model}...`);
  const result = await ollamaContainer.exec(["ollama", "pull", model]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to pull model: ${result.output}`);
  }
  console.log(`Model ${model} ready.`);
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
  ollama?: ContainerEndpoint;
  minio?: ContainerEndpoint;
}) {
  return {
    databaseUrl: `postgresql://cogmo@${containers.postgres.getHost()}:${containers.postgres.getMappedPort(5432)}/cogmo`,
    inngestBaseUrl: `http://${containers.inngest.getHost()}:${containers.inngest.getMappedPort(8288)}`,
    ...(containers.hindsight && {
      hindsightUrl: `http://${containers.hindsight.getHost()}:${containers.hindsight.getMappedPort(8888)}`,
    }),
    ...(containers.ollama && {
      ollamaUrl: `http://${containers.ollama.getHost()}:${containers.ollama.getMappedPort(11434)}`,
    }),
    ...(containers.minio && {
      s3Endpoint: `http://${containers.minio.getHost()}:${containers.minio.getMappedPort(9000)}`,
    }),
  };
}
