#!/usr/bin/env tsx
/**
 * Start dev infrastructure + app in one command.
 *
 * Usage:
 *   pnpm dev:infra        — start infra, apply migrations, spawn the app
 *   pnpm dev:infra --only — start infra only (print env vars, no app)
 *
 * Containers use withReuse() — they survive across restarts.
 * First run pulls images + applies migrations. Subsequent runs reuse existing containers.
 * Ctrl+C stops the app; containers keep running (reuse). Use `docker stop` to kill them.
 */
import { spawn } from "node:child_process";
import { Network } from "testcontainers";
import * as c from "../test/containers.js";

async function main() {
  const infraOnly = process.argv.includes("--only");
  const network = await new Network().start();

  console.log("Starting dev infrastructure...\n");

  const [pg, _rd, inn] = await Promise.all([
    c
      .postgres(network)
      .withReuse()
      .start()
      .then((ct) => {
        console.log("  Postgres ready");
        return ct;
      }),
    c
      .redis(network)
      .withReuse()
      .start()
      .then((ct) => {
        console.log("  Redis ready");
        return ct;
      }),
    c
      .inngest(network)
      .withReuse()
      .start()
      .then((ct) => {
        console.log("  Inngest ready");
        return ct;
      }),
  ]);

  // Hindsight with Anthropic (dev uses real API, not Ollama)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY not set. Hindsight needs it for LLM extraction.");
    process.exit(1);
  }

  const hindsightContainer = await c
    .hindsight(network, "anthropic", { apiKey })
    .withReuse()
    .start();
  console.log("  Hindsight ready");

  // Build env vars
  const databaseUrl = `postgresql://assistant@${pg.getHost()}:${pg.getMappedPort(5432)}/assistant`;
  const inngestBaseUrl = `http://${inn.getHost()}:${inn.getMappedPort(8288)}`;
  const hindsightUrl = `http://${hindsightContainer.getHost()}:${hindsightContainer.getMappedPort(8888)}`;

  // Run seed (applies migrations + creates default data, idempotent)
  console.log("\nRunning seed...");
  const { execSync } = await import("node:child_process");
  execSync("tsx src/cli.ts seed", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  console.log("Seed complete.\n");

  const envVars = {
    DATABASE_URL: databaseUrl,
    INNGEST_BASE_URL: inngestBaseUrl,
    HINDSIGHT_URL: hindsightUrl,
  };

  if (infraOnly) {
    console.log("--- Environment variables ---\n");
    for (const [k, v] of Object.entries(envVars)) {
      console.log(`${k}=${v}`);
    }
    console.log("\nInfra ready. Containers will keep running (reuse enabled).");
    return;
  }

  // Spawn the app with infra env vars injected
  console.log("Starting app...\n");
  const child = spawn("tsx", ["watch", "src/index.ts"], {
    stdio: "inherit",
    env: { ...process.env, ...envVars },
  });

  child.on("exit", (code) => {
    // Don't stop containers — they're reusable
    console.log(`\nApp exited (code ${code}). Containers still running (reuse).`);
    process.exit(code ?? 0);
  });

  // Forward signals to child
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => child.kill(sig));
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
