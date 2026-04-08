import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import type { LLMock } from "@copilotkit/aimock";
import type { StartedTestContainer } from "testcontainers";
import { GenericContainer, Network, Wait } from "testcontainers";
import type { GlobalSetupContext } from "vitest/node";
import * as c from "../dev/containers.js";
import { createMock } from "./llmock-setup.js";

// Load .env for recording mode — API keys needed for real upstream calls
if (existsSync(".env")) loadEnvFile(".env");

/// <reference path="./vitest.d.ts" />

const containers: StartedTestContainer[] = [];
let network: Awaited<ReturnType<InstanceType<typeof Network>["start"]>> | null = null;
let mock: LLMock | null = null;

export async function setup({ provide }: GlobalSetupContext) {
  network = await new Network().start();

  mock = createMock();
  await mock.start();
  console.log(`llmock at ${mock.url}`);

  console.log("Starting containers...");
  const [pg, _rd, inn, mn] = await Promise.all([
    c.postgres(network).start(),
    c.redis(network).start(),
    c.inngest(network).start(),
    c.minio(network).start(),
  ]);
  containers.push(pg, _rd, inn, mn);

  // Slim Hindsight
  const llmockUrl = `http://host.docker.internal:${mock.port}/v1`;
  const hindsightContainer = await c
    .hindsightSlim(network, {
      llmBaseUrl: llmockUrl,
      llmApiKey: process.env.OPENAI_API_KEY ?? "test-key",
      llmModel: "gpt-5-nano",
      embeddingsBaseUrl: llmockUrl,
      embeddingsApiKey: process.env.OPENAI_API_KEY ?? "test-key",
      embeddingsModel: "text-embedding-3-small",
    })
    .start();
  containers.push(hindsightContainer);

  const { hindsightUrl, s3Endpoint, ...urls } = c.getUrls({
    postgres: pg,
    inngest: inn,
    hindsight: hindsightContainer,
    minio: mn,
  });
  if (!hindsightUrl) throw new Error("hindsight is required for e2e");
  if (!s3Endpoint) throw new Error("minio is required for e2e");

  // Create the S3 bucket in MinIO
  const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({
    endpoint: s3Endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
  });
  await s3.send(new CreateBucketCommand({ Bucket: "assistant-files" }));
  s3.destroy();

  // Use pre-built Docker image if available (CI builds it), otherwise build from Dockerfile.
  const imageName = process.env.E2E_IMAGE ?? "assistant-e2e";
  let appImage: GenericContainer;
  if (process.env.E2E_IMAGE) {
    console.log(`Using pre-built image: ${imageName}`);
    appImage = new GenericContainer(imageName);
  } else {
    console.log("Building app Docker image...");
    appImage = await GenericContainer.fromDockerfile(".", "Dockerfile").build(imageName);
  }

  console.log("Running seed...");
  const seedContainer = await appImage
    .withNetwork(network)
    .withCommand(["seed"])
    .withEnvironment({ DATABASE_URL: "postgresql://assistant@postgres:5432/assistant" })
    .withWaitStrategy(Wait.forLogMessage(/seed complete/i))
    .withStartupTimeout(60_000)
    .start();
  await seedContainer.stop();
  console.log("Seed complete.");

  const postgres = (await import("postgres")).default;
  const sql = postgres(urls.databaseUrl);
  const rows = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
  await sql.end();
  const defaultUserId = rows[0]?.id;
  if (!defaultUserId) throw new Error("Default user not found after seed");

  console.log("Starting app container (connect mode)...");
  const appContainer = await appImage
    .withNetwork(network)
    .withExtraHosts([{ host: "host.docker.internal", ipAddress: "host-gateway" }])
    .withCommand(["serve"])
    .withEnvironment({
      DATABASE_URL: "postgresql://assistant@postgres:5432/assistant",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "test-key",
      ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}`,
      INNGEST_BASE_URL: "http://inngest:8288",
      INNGEST_CONNECT_GATEWAY_URL: "ws://inngest:8289/v0/connect",
      HINDSIGHT_URL: "http://hindsight:8888",
      S3_ENDPOINT: "http://minio:9000",
      S3_ACCESS_KEY: "minioadmin",
      S3_SECRET_KEY: "minioadmin",
      S3_BUCKET: "assistant-files",
      INNGEST_DEV: "true",
      LOG_LEVEL: "info",
    })
    .withWaitStrategy(Wait.forLogMessage(/inngest connected/i))
    .withStartupTimeout(60_000)
    .start();
  containers.push(appContainer);
  console.log("App container ready.");

  provide("databaseUrl", urls.databaseUrl);
  provide("inngestBaseUrl", urls.inngestBaseUrl);
  provide("inngestEventKey", "test");
  provide("hindsightUrl", hindsightUrl);
  provide("defaultUserId", defaultUserId);

  console.log(`E2E environment ready — ${JSON.stringify({ ...urls, hindsightUrl })}`);
}

export async function teardown() {
  if (mock) await mock.stop();

  console.log("Stopping containers...");
  for (const container of containers.reverse()) {
    await container.stop();
  }
  if (network) await network.stop();
  console.log("Containers stopped.");
}
