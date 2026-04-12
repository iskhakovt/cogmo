import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import type { LLMock } from "@copilotkit/aimock";
import type { StartedTestContainer } from "testcontainers";
import { Network } from "testcontainers";
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

  // Slim Hindsight — external LLM + embeddings via llmock (replays recorded fixtures)
  const llmockUrl = `http://host.docker.internal:${mock.port}/v1`;
  const hindsightContainer = await c
    .hindsightSlim(network, {
      llmBaseUrl: llmockUrl,
      llmApiKey: process.env.OPENAI_API_KEY ?? "test-key",
      llmModel: "gpt-4o-mini",
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
  if (!hindsightUrl) throw new Error("hindsight is required for integration tests");
  if (!s3Endpoint) throw new Error("minio is required for integration tests");

  // Create the S3 bucket in MinIO
  const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({
    endpoint: s3Endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
  });
  await s3.send(new CreateBucketCommand({ Bucket: "cogmo-files" }));
  s3.destroy();

  // Set process.env — propagates to Vitest test workers.
  process.env.DATABASE_URL = urls.databaseUrl;
  // Master key for secrets store — tests use providerOverride so no real
  // credentials are stored, but bootstrap requires the key unconditionally.
  process.env.COGMO_MASTER_KEY = "bSK9MVRqsqWnRcp4oNTQLQ+LmKJT+BvUvzytD5LH4AE="; // 32 bytes base64 (test-only)
  process.env.HINDSIGHT_URL = hindsightUrl;
  process.env.INNGEST_BASE_URL = urls.inngestBaseUrl;
  process.env.INNGEST_DEV = "true";
  process.env.DEBOUNCE_IDLE_SECONDS = "0";
  process.env.DEBOUNCE_MAXWAIT_SECONDS = "0";
  process.env.S3_ENDPOINT = s3Endpoint;
  process.env.S3_ACCESS_KEY = "minioadmin";
  process.env.S3_SECRET_KEY = "minioadmin";
  process.env.S3_BUCKET = "cogmo-files";
  process.env.LOG_LEVEL = "warn";

  const gatewayUrl = `ws://${inn.getHost()}:${inn.getMappedPort(8289)}/v0/connect`;
  process.env.INNGEST_CONNECT_GATEWAY_URL = gatewayUrl;

  console.log("Running seed...");
  execSync("tsx src/main.ts seed", { stdio: "inherit" });
  console.log("Seed complete.");

  const postgres = (await import("postgres")).default;
  const sql = postgres(urls.databaseUrl);
  const rows = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
  await sql.end();
  const defaultUserId = rows[0]?.id;
  if (!defaultUserId) throw new Error("Default user not found after seed");

  provide("databaseUrl", urls.databaseUrl);
  provide("inngestBaseUrl", urls.inngestBaseUrl);
  provide("inngestEventKey", "test");
  provide("hindsightUrl", hindsightUrl);
  provide("defaultUserId", defaultUserId);

  console.log(`Integration test environment ready — ${JSON.stringify({ ...urls, hindsightUrl })}`);
}

export async function teardown() {
  if (mock) await mock.stop();

  console.log("Stopping test containers...");
  for (const container of containers.reverse()) {
    await container.stop();
  }
  if (network) await network.stop();
  console.log("Test containers stopped.");
}
