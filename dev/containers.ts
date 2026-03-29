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
      POSTGRES_USER: "assistant",
      POSTGRES_DB: "assistant",
      POSTGRES_HOST_AUTH_METHOD: "trust",
    })
    .withCopyFilesToContainer([
      { source: "./scripts/init-db.sql", target: "/docker-entrypoint-initdb.d/init.sql" },
    ])
    .withWaitStrategy(Wait.forSuccessfulCommand("pg_isready -U assistant"))
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

  return new GenericContainer("ghcr.io/vectorize-io/hindsight:latest")
    .withNetwork(network)
    .withNetworkAliases("hindsight")
    .withExposedPorts(8888)
    .withExtraHosts([{ host: "host.docker.internal", ipAddress: "host-gateway" }])
    .withEnvironment(env)
    .withWaitStrategy(Wait.forHttp("/health", 8888))
    .withStartupTimeout(120_000);
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
}) {
  return {
    databaseUrl: `postgresql://assistant@${containers.postgres.getHost()}:${containers.postgres.getMappedPort(5432)}/assistant`,
    inngestBaseUrl: `http://${containers.inngest.getHost()}:${containers.inngest.getMappedPort(8288)}`,
    ...(containers.hindsight && {
      hindsightUrl: `http://${containers.hindsight.getHost()}:${containers.hindsight.getMappedPort(8888)}`,
    }),
    ...(containers.ollama && {
      ollamaUrl: `http://${containers.ollama.getHost()}:${containers.ollama.getMappedPort(11434)}`,
    }),
  };
}
