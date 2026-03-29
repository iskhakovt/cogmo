import type { ChildProcess } from "node:child_process";
import { execSync, spawn } from "node:child_process";
import type { StartedTestContainer } from "testcontainers";
import { Network } from "testcontainers";
import type { GlobalSetupContext } from "vitest/node";
import * as c from "./containers.js";

/// <reference path="./vitest.d.ts" />

const containers: StartedTestContainer[] = [];
let network: Awaited<ReturnType<InstanceType<typeof Network>["start"]>> | null = null;
let appProcess: ChildProcess | null = null;

export async function setup({ provide }: GlobalSetupContext) {
  network = await new Network().start();

  // Start infra containers (parallel where possible)
  console.log("Starting containers...");
  const [pg, _rd, inn] = await Promise.all([
    c.postgres(network).start(),
    c.redis(network).start(),
    c.inngest(network).start(),
  ]);
  containers.push(pg, _rd, inn);

  // Ollama: start, pull model, then start Hindsight (sequential — Hindsight needs the model)
  const ollamaContainer = await c.ollama(network).start();
  containers.push(ollamaContainer);
  await c.pullModel(ollamaContainer, c.OLLAMA_MODEL);

  const hindsightContainer = await c.hindsight(network, "ollama").start();
  containers.push(hindsightContainer);

  // Mock Anthropic for pipeline test
  const mockAnthropicContainer = await c.mockAnthropic(network);
  containers.push(mockAnthropicContainer);

  // Get URLs
  const urls = c.getUrls({
    postgres: pg,
    inngest: inn,
    hindsight: hindsightContainer,
    ollama: ollamaContainer,
  });
  const mockAnthropicUrl = `http://${mockAnthropicContainer.getHost()}:${mockAnthropicContainer.getMappedPort(3000)}`;

  // Seed database (applies migrations + creates default data)
  console.log("Running seed...");
  execSync("tsx src/cli.ts seed", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: urls.databaseUrl },
  });
  console.log("Seed complete.");

  // Query the default user created by seed
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const setupDb = drizzle({ connection: urls.databaseUrl });
  const result = await setupDb.$client.query<{ id: string }>("SELECT id FROM users LIMIT 1");
  await setupDb.$client.end();
  const defaultUserId = result.rows[0]?.id;
  if (!defaultUserId) throw new Error("Default user not found after seed");

  // Start the assistant app in connect mode (WebSocket to Inngest dev server)
  // Connect mode initiates outbound — no function discovery timing issues.
  // connect() only resolves after successful handshake, so "inngest connected" is accurate.
  const gatewayUrl = `ws://${inn.getHost()}:${inn.getMappedPort(8289)}/v0/connect`;
  console.log("Starting assistant app (connect mode)...");
  appProcess = spawn("tsx", ["src/index.ts"], {
    stdio: "pipe",
    env: {
      ...process.env,
      DATABASE_URL: urls.databaseUrl,
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_BASE_URL: mockAnthropicUrl,
      INNGEST_BASE_URL: urls.inngestBaseUrl,
      INNGEST_CONNECT_GATEWAY_URL: gatewayUrl,
      HINDSIGHT_URL: urls.hindsightUrl,
      INNGEST_DEV: "true",
      LOG_LEVEL: "info",
    },
  });

  // Wait for "inngest connected" in stdout — in connect mode this means the WebSocket
  // handshake succeeded and functions are registered with the dev server.
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
  provide("hindsightUrl", urls.hindsightUrl);
  provide("ollamaUrl", urls.ollamaUrl);
  provide("defaultUserId", defaultUserId);

  console.log(`Test environment ready — ${JSON.stringify(urls)}`);
}

export async function teardown() {
  // Stop app first
  if (appProcess) {
    console.log("Stopping assistant app...");
    appProcess.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      appProcess?.on("exit", () => resolve());
      setTimeout(resolve, 5_000); // force proceed after 5s
    });
  }

  console.log("Stopping test containers...");
  for (const container of containers.reverse()) {
    await container.stop();
  }
  if (network) await network.stop();
  console.log("Test containers stopped.");
}
