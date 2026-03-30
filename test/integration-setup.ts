import { execSync } from "node:child_process";
import { LLMock } from "@copilotkit/llmock";
import type { StartedTestContainer } from "testcontainers";
import { Network } from "testcontainers";
import type { GlobalSetupContext } from "vitest/node";
import * as c from "../dev/containers.js";

/// <reference path="./vitest.d.ts" />

const containers: StartedTestContainer[] = [];
let network: Awaited<ReturnType<InstanceType<typeof Network>["start"]>> | null = null;
let mock: LLMock | null = null;

export async function setup({ provide }: GlobalSetupContext) {
  network = await new Network().start();

  // llmock serves Anthropic API for both our app and Hindsight.
  // Recorded fixtures (from scripts/record-fixtures.ts) provide realistic Hindsight responses.
  // The catch-all fixture handles our app's direct LLM calls.
  mock = new LLMock({ port: 0, host: "0.0.0.0", logLevel: "silent" });
  mock.loadFixtureDir("./test/fixtures/recorded");
  mock.onMessage(/./, { content: "Mock integration response from llmock" });
  // Catch-all embedding fixture — returns deterministic 1536-dim vector for any input.
  // Hindsight decorates text with timestamps/metadata before embedding, making
  // exact inputText matching fragile. The catch-all ensures all embedding calls succeed.
  mock.onEmbedding(/./, { embedding: Array.from({ length: 1536 }, (_, i) => Math.sin(i) * 0.1) });
  await mock.start();
  console.log(`llmock at ${mock.url}`);

  console.log("Starting containers...");
  const [pg, _rd, inn] = await Promise.all([
    c.postgres(network).start(),
    c.redis(network).start(),
    c.inngest(network).start(),
  ]);
  containers.push(pg, _rd, inn);

  // Slim Hindsight — external LLM + embeddings via llmock (replays recorded fixtures)
  const llmockUrl = `http://host.docker.internal:${mock.port}/v1`;
  const hindsightContainer = await c
    .hindsightSlim(network, {
      llmBaseUrl: llmockUrl,
      llmApiKey: "test-key",
      llmModel: "gpt-5-nano",
      embeddingsBaseUrl: llmockUrl,
      embeddingsApiKey: "test-key",
      embeddingsModel: "text-embedding-3-small",
    })
    .start();
  containers.push(hindsightContainer);

  const { hindsightUrl, ...urls } = c.getUrls({
    postgres: pg,
    inngest: inn,
    hindsight: hindsightContainer,
  });
  if (!hindsightUrl) throw new Error("hindsight is required for integration tests");

  // Set process.env — propagates to Vitest test workers.
  // This allows test files to do normal top-level imports of app modules
  // that transitively import env.ts (createEnv validates process.env at import time).
  process.env.DATABASE_URL = urls.databaseUrl;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${mock.port}`;
  process.env.HINDSIGHT_URL = hindsightUrl;
  process.env.INNGEST_BASE_URL = urls.inngestBaseUrl;
  process.env.INNGEST_DEV = "true";
  process.env.LOG_LEVEL = "warn";

  // Gateway URL for connect mode — tests use this to register functions in-process
  const gatewayUrl = `ws://${inn.getHost()}:${inn.getMappedPort(8289)}/v0/connect`;
  process.env.INNGEST_CONNECT_GATEWAY_URL = gatewayUrl;

  // Seed database
  console.log("Running seed...");
  execSync("tsx src/cli.ts seed", { stdio: "inherit" });
  console.log("Seed complete.");

  // Query the default user created by seed
  const postgres = (await import("postgres")).default;
  const sql = postgres(urls.databaseUrl);
  const rows = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
  await sql.end();
  const defaultUserId = rows[0]?.id;
  if (!defaultUserId) throw new Error("Default user not found after seed");

  // Also provide values for direct use in tests via inject()
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
