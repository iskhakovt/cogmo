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
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Network } from "testcontainers";
import * as c from "../dev/containers.js";

/**
 * Project-local scratch root for `pnpm dev`. Holds skills repo, cloned
 * repos, worktrees, sockets, askpass material — anything `env.ts` would
 * default to `/var/lib/cogmo/...` or `/run/cogmo/...` in production.
 *
 * In-repo (gitignored) follows the same convention as `node_modules`,
 * `.next`, `.turbo`, `target/`, `.gradle/` — dev artifacts owned by the
 * checkout, scoped per clone, wiped by `git clean -fdx`.
 */
const DEV_ROOT = ".dev";

async function main() {
  const infraOnly = process.argv.includes("--only");
  const network = await new Network().start();

  console.log("Starting dev infrastructure...\n");

  function startWithProgress<T>(name: string, factory: () => Promise<T>): Promise<T> {
    console.log(`  ${name} starting...`);
    return factory().then((ct) => {
      console.log(`  ${name} ready`);
      return ct;
    });
  }

  const [pg, _rd, inn] = await Promise.all([
    startWithProgress("Postgres", () => c.postgres(network).withReuse().start()),
    startWithProgress("Redis", () => c.redis(network).withReuse().start()),
    startWithProgress("Inngest", () => c.inngest(network).withReuse().start()),
  ]);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY not set. Hindsight needs it for LLM extraction.");
    process.exit(1);
  }

  const hindsightContainer = await startWithProgress("Hindsight", () =>
    c.hindsight(network, { apiKey }).withReuse().start(),
  );

  // Build env vars
  const databaseUrl = `postgresql://cogmo@${pg.getHost()}:${pg.getMappedPort(5432)}/cogmo`;
  const inngestBaseUrl = `http://${inn.getHost()}:${inn.getMappedPort(8288)}`;
  const hindsightUrl = `http://${hindsightContainer.getHost()}:${hindsightContainer.getMappedPort(8888)}`;

  // Run seed (applies migrations + creates default data, idempotent)
  console.log("\nRunning seed...");
  const { execSync } = await import("node:child_process");
  execSync("tsx src/main.ts seed", {
    stdio: "inherit",
    env: { NODE_ENV: "development", ...process.env, DATABASE_URL: databaseUrl },
  });
  console.log("Seed complete.\n");

  // Override the prod-flavoured `/var/lib/cogmo/...` and `/run/cogmo/...`
  // defaults from `env.ts` with project-local scratch paths under `.dev/`
  // so `pnpm dev` runs without sudo. Anything the developer pre-exports
  // wins (`process.env.X` spread last).
  mkdirSync(DEV_ROOT, { recursive: true });
  const envVars = {
    NODE_ENV: "development",
    COGMO_SKILLS_PATH: join(DEV_ROOT, "skills"),
    COGMO_REPOS_DIR: join(DEV_ROOT, "repos"),
    COGMO_WORKTREES_DIR: join(DEV_ROOT, "worktrees"),
    SANDBOX_PROXY_SOCKET_DIR: join(DEV_ROOT, "sockets"),
    SANDBOX_ASKPASS_DIR: join(DEV_ROOT, "askpass"),
    ...process.env,
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

  // Spawn the app with infra env vars injected. `src/main.ts` is the actual
  // entrypoint (it calls bootstrap() and starts the health server);
  // `src/index.ts` only exports bootstrap() and never executes anything at
  // module load.
  console.log("Running app (tsx watch src/main.ts serve). Ctrl+C to stop.\n");
  const child = spawn("tsx", ["watch", "src/main.ts", "serve"], {
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
