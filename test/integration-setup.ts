import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import type { LLMock } from "@copilotkit/aimock";
import type { StartedTestContainer } from "testcontainers";
import { Network } from "testcontainers";
import type { GlobalSetupContext } from "vitest/node";
import * as c from "../dev/containers.js";
import { startMcpEchoHttpServer } from "../src/test/mcp-http-echo-server.js";
import { createMock } from "./llmock-setup.js";
import { startTelegramMockServer, type TelegramMockServer } from "./telegram-mock.js";

// Load .env for recording mode — API keys needed for real upstream calls
if (existsSync(".env")) loadEnvFile(".env");

/// <reference path="./vitest.d.ts" />

const containers: StartedTestContainer[] = [];
let network: Awaited<ReturnType<InstanceType<typeof Network>["start"]>> | null = null;
let mock: LLMock | null = null;
let telegramMock: TelegramMockServer | null = null;
let mcpEchoServer: Awaited<ReturnType<typeof startMcpEchoHttpServer>> | null = null;
let skillsPath: string | null = null;

/**
 * Bot token for the seeded integration-test Telegram channel. Format matches
 * BotFather's `<bot_id>:<random>` shape so grammY's URL builder produces a
 * well-formed path. Never sent to real Telegram — every request is intercepted
 * by `telegramMock`.
 */
const TELEGRAM_TEST_BOT_TOKEN = "1234567890:fake-test-token";

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
  // fal-mock intercepts all real network traffic in tests, so the dummy key
  // is never validated. Real key passes through in record mode when the
  // operator sets it locally: RECORD=1 FAL_API_KEY=... pnpm test:integration.
  process.env.FAL_API_KEY = process.env.FAL_API_KEY ?? "test-fal-key";
  // Required env var (no default after the multi-tenant-footgun fix).
  // Per-test-run volume name so parallel integration files don't share
  // a populated venv cache.
  process.env.COGMO_SKILLS_DEPS_VOLUME = `cogmo-skills-deps-test-${randomUUID()}`;

  // Skills bare repo lives on the host (not in a container) — bootstrap
  // initializes it on every boot. Use a tempdir so tests don't try to write
  // to the production default `/var/lib/cogmo/skills`.
  skillsPath = await mkdtemp(join(tmpdir(), "cogmo-skills-it-"));
  process.env.COGMO_SKILLS_PATH = skillsPath;

  const gatewayUrl = `ws://${inn.getHost()}:${inn.getMappedPort(8289)}/v0/connect`;
  process.env.INNGEST_CONNECT_GATEWAY_URL = gatewayUrl;

  // Telegram Bot API mock — listens on 127.0.0.1:<random>. Seeded into the
  // `channels` row's `apiRoot` credential below so every grammY API call from
  // the in-process bot AND any subprocess that boots `bootstrap()` (e.g.
  // `cli.integration.test.ts`'s seed/CLI subprocesses) lands here instead of
  // real Telegram. No env var needed — the URL travels through the DB row.
  telegramMock = await startTelegramMockServer();
  console.log(`telegram-mock at ${telegramMock.url}`);

  // MCP echo server reachable over Streamable HTTP. Shared across workers
  // so the production `HostRunner` can connect from whichever worker
  // Inngest routes an `inbound/arrived` event to — no per-worker injection
  // required.
  mcpEchoServer = await startMcpEchoHttpServer();
  console.log(`mcp-echo at ${mcpEchoServer.url}`);

  console.log("Running seed...");
  execSync("tsx src/main.ts seed", { stdio: "inherit" });
  console.log("Seed complete.");

  const postgres = (await import("postgres")).default;
  const sql = postgres(urls.databaseUrl);
  const rows = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
  // Telegram channel fixture — `bootstrap()` iterates every channel row
  // through `startChannels`, which constructs a grammY `Bot` with these
  // credentials. The `apiRoot` field is consumed by the Telegram adapter's
  // `setup()` and routes all bot API calls to the mock above.
  await sql`
    INSERT INTO channels (type, credentials, identity_mode)
    SELECT 'telegram', ${sql.json({ token: TELEGRAM_TEST_BOT_TOKEN, apiRoot: telegramMock.url })}, 'create'
    WHERE NOT EXISTS (SELECT 1 FROM channels WHERE type = 'telegram')
  `;
  await sql.end();
  const defaultUserId = rows[0]?.id;
  if (!defaultUserId) throw new Error("Default user not found after seed");

  provide("databaseUrl", urls.databaseUrl);
  provide("inngestBaseUrl", urls.inngestBaseUrl);
  provide("inngestEventKey", "test");
  provide("hindsightUrl", hindsightUrl);
  provide("defaultUserId", defaultUserId);
  provide("llmockBaseUrl", mock.url);
  provide("mcpEchoUrl", mcpEchoServer.url);

  console.log(`Integration test environment ready — ${JSON.stringify({ ...urls, hindsightUrl })}`);
}

export async function teardown() {
  if (mock) await mock.stop();
  if (telegramMock) await telegramMock.stop();
  if (mcpEchoServer) await mcpEchoServer.close();

  console.log("Stopping test containers...");
  for (const container of containers.reverse()) {
    await container.stop();
  }
  if (network) await network.stop();
  if (skillsPath) {
    await rm(skillsPath, { recursive: true, force: true });
  }
  // Drop the per-run skill-deps cache volume so long-running dev
  // machines don't accumulate one per integration-test invocation.
  // Best-effort: in-use / already-gone is fine. CI runners are
  // ephemeral so the cleanup only matters on the dev seat.
  const depsVolume = process.env.COGMO_SKILLS_DEPS_VOLUME;
  if (depsVolume?.startsWith("cogmo-skills-deps-test-")) {
    const { default: Docker } = await import("dockerode");
    await new Docker()
      .getVolume(depsVolume)
      .remove()
      .catch(() => {});
  }
  console.log("Test containers stopped.");
}
