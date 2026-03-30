import type { ChildProcess } from "node:child_process";
import { execSync, spawn } from "node:child_process";
import { LLMock } from "@copilotkit/llmock";
import type { StartedTestContainer } from "testcontainers";
import { Network } from "testcontainers";
import type { GlobalSetupContext } from "vitest/node";
import * as c from "../dev/containers.js";

/// <reference path="./vitest.d.ts" />

const containers: StartedTestContainer[] = [];
let network: Awaited<ReturnType<InstanceType<typeof Network>["start"]>> | null = null;
let appProcess: ChildProcess | null = null;
let mock: LLMock | null = null;

export async function setup({ provide }: GlobalSetupContext) {
  network = await new Network().start();

  const recording = process.env.LLMOCK_RECORD === "1";
  mock = new LLMock({
    port: 0,
    host: "0.0.0.0",
    logLevel: recording ? "info" : "silent",
    strict: !recording,
    ...(recording && {
      record: {
        providers: { openai: "https://api.openai.com" },
        fixturePath: "./test/fixtures/recorded",
      },
    }),
  });
  mock.loadFixtureDir("./test/fixtures/recorded");
  await mock.start();
  console.log(`llmock at ${mock.url}`);

  // Start infra containers (parallel where possible)
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

  // Get URLs
  const { hindsightUrl, ...urls } = c.getUrls({
    postgres: pg,
    inngest: inn,
    hindsight: hindsightContainer,
  });
  if (!hindsightUrl) throw new Error("hindsight is required for e2e");

  // Seed database (applies migrations + creates default data)
  console.log("Running seed...");
  execSync("tsx src/cli.ts seed", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: urls.databaseUrl },
  });
  console.log("Seed complete.");

  // Query the default user created by seed
  const postgres = (await import("postgres")).default;
  const sql = postgres(urls.databaseUrl);
  const rows = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
  await sql.end();
  const defaultUserId = rows[0]?.id;
  if (!defaultUserId) throw new Error("Default user not found after seed");

  // Start the assistant app in connect mode (WebSocket to Inngest dev server)
  const gatewayUrl = `ws://${inn.getHost()}:${inn.getMappedPort(8289)}/v0/connect`;
  console.log("Starting assistant app (connect mode)...");
  appProcess = spawn("tsx", ["src/index.ts"], {
    stdio: "pipe",
    env: {
      ...process.env,
      DATABASE_URL: urls.databaseUrl,
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_BASE_URL: `http://localhost:${mock.port}`,
      INNGEST_BASE_URL: urls.inngestBaseUrl,
      INNGEST_CONNECT_GATEWAY_URL: gatewayUrl,
      HINDSIGHT_URL: hindsightUrl,
      INNGEST_DEV: "true",
      LOG_LEVEL: "info",
    },
  });

  // Wait for "inngest connected" in stdout
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("App startup timeout — 'inngest connected' not seen")),
      60_000,
    );
    appProcess?.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      process.stdout.write(`[app] ${text}`);
      if (text.includes("inngest connected")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    appProcess?.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[app:err] ${data}`);
    });
    appProcess?.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`App exited unexpectedly with code ${code}`));
    });
  });
  console.log("Assistant app ready.");

  provide("databaseUrl", urls.databaseUrl);
  provide("inngestBaseUrl", urls.inngestBaseUrl);
  provide("inngestEventKey", "test");
  provide("hindsightUrl", hindsightUrl);
  provide("defaultUserId", defaultUserId);

  console.log(`Test environment ready — ${JSON.stringify({ ...urls, hindsightUrl })}`);
}

export async function teardown() {
  if (appProcess) {
    console.log("Stopping assistant app...");
    appProcess.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      appProcess?.on("exit", () => resolve());
      setTimeout(resolve, 5_000);
    });
  }

  if (mock) await mock.stop();

  console.log("Stopping test containers...");
  for (const container of containers.reverse()) {
    await container.stop();
  }
  if (network) await network.stop();
  console.log("Test containers stopped.");
}
