import {
  DockerComposeEnvironment,
  type StartedDockerComposeEnvironment,
  Wait,
} from "testcontainers";
import type { GlobalSetupContext } from "vitest/node";

/// <reference path="./vitest.d.ts" />

let environment: StartedDockerComposeEnvironment | null = null;

export async function setup({ provide }: GlobalSetupContext) {
  console.log("Starting test containers...");

  environment = await new DockerComposeEnvironment(".", "docker-compose.yml")
    .withBuild()
    .withProfiles("test")
    .withWaitStrategy("postgres-1", Wait.forHealthCheck())
    .withWaitStrategy("redis-1", Wait.forHealthCheck())
    .withWaitStrategy("inngest-1", Wait.forHealthCheck())
    .withWaitStrategy("mock-anthropic-1", Wait.forHealthCheck())
    .withWaitStrategy("ollama-1", Wait.forHealthCheck())
    .withWaitStrategy("hindsight-test-1", Wait.forHealthCheck())
    .withWaitStrategy("assistant-1", Wait.forLogMessage("inngest connected"))
    .up();

  const postgresHost = environment.getContainer("postgres-1").getHost();
  const postgresPort = environment.getContainer("postgres-1").getMappedPort(5432);
  const inngestHost = environment.getContainer("inngest-1").getHost();
  const inngestPort = environment.getContainer("inngest-1").getMappedPort(8288);
  const hindsightHost = environment.getContainer("hindsight-test-1").getHost();
  const hindsightPort = environment.getContainer("hindsight-test-1").getMappedPort(8888);

  const databaseUrl = `postgresql://assistant@${postgresHost}:${postgresPort}/assistant`;
  const inngestBaseUrl = `http://${inngestHost}:${inngestPort}`;
  const hindsightUrl = `http://${hindsightHost}:${hindsightPort}`;

  provide("databaseUrl", databaseUrl);
  provide("inngestBaseUrl", inngestBaseUrl);
  provide("inngestEventKey", "test");
  provide("hindsightUrl", hindsightUrl);

  console.log(
    `Test containers ready — postgres=${databaseUrl}, inngest=${inngestBaseUrl}, hindsight=${hindsightUrl}`,
  );
}

export async function teardown() {
  console.log("Stopping test containers...");
  await environment?.down({ removeVolumes: true });
  console.log("Test containers stopped.");
}
