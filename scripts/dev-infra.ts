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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Network } from "testcontainers";
import * as c from "../dev/containers.js";
import { generateMasterKey } from "../src/secrets/encryption.js";

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
  // Inngest dev server exposes the connect WebSocket gateway on a separate
  // port (8289). The Inngest SDK's `connect()` reads this env var; without
  // it the SDK falls back to a default that doesn't match the local
  // container, manifesting as "Reconnecting after failure" in a loop.
  const inngestConnectGatewayUrl = `ws://${inn.getHost()}:${inn.getMappedPort(8289)}/v0/connect`;
  const hindsightUrl = `http://${hindsightContainer.getHost()}:${hindsightContainer.getMappedPort(8888)}`;

  // Override the prod-flavoured `/var/lib/cogmo/...` and `/run/cogmo/...`
  // defaults from `env.ts` with project-local scratch paths under `.dev/`
  // so `pnpm dev` runs without sudo. Anything the developer pre-exports
  // wins (`process.env.X` spread last).
  mkdirSync(DEV_ROOT, { recursive: true });

  // Auto-generate and persist a master key on first run so devs don't have
  // to run `cogmo gen-key` + edit `.env` manually. Stored under .dev/ so it
  // shares the gitignored scratch lifecycle.
  const masterKeyPath = join(DEV_ROOT, "master-key");
  let masterKey = process.env.COGMO_MASTER_KEY;
  if (!masterKey) {
    if (existsSync(masterKeyPath)) {
      masterKey = readFileSync(masterKeyPath, "utf8").trim();
    } else {
      masterKey = generateMasterKey();
      writeFileSync(masterKeyPath, masterKey, { mode: 0o600 });
      console.log(`Generated dev master key at ${masterKeyPath}`);
    }
  }

  // Run seed (applies migrations + creates default data, idempotent)
  console.log("\nRunning seed...");
  const { execSync } = await import("node:child_process");
  const seedEnv = {
    NODE_ENV: "development",
    ...process.env,
    DATABASE_URL: databaseUrl,
    COGMO_MASTER_KEY: masterKey,
  };
  execSync("tsx src/main.ts seed", { stdio: "inherit", env: seedEnv });
  console.log("Seed complete.\n");

  // Run non-interactive setup if ANTHROPIC_API_KEY is present and no
  // provider is configured yet — devs already export that var for
  // Hindsight, so registering it as the LLM provider too saves them a
  // separate `cogmo setup` step. Idempotent: the wizard's non-interactive
  // path replaces an existing provider with the same name.
  console.log("Configuring LLM provider...");
  execSync("tsx src/main.ts setup --non-interactive", {
    stdio: "inherit",
    env: {
      ...seedEnv,
      COGMO_LLM_PROVIDER_TYPE: "anthropic",
      COGMO_LLM_API_KEY: apiKey,
    },
  });
  console.log("Setup complete.\n");

  const envVars = {
    NODE_ENV: "development",
    COGMO_SKILLS_PATH: join(DEV_ROOT, "skills"),
    COGMO_REPOS_DIR: join(DEV_ROOT, "repos"),
    COGMO_WORKTREES_DIR: join(DEV_ROOT, "worktrees"),
    SANDBOX_PROXY_SOCKET_DIR: join(DEV_ROOT, "sockets"),
    SANDBOX_ASKPASS_DIR: join(DEV_ROOT, "askpass"),
    ...process.env,
    COGMO_MASTER_KEY: masterKey,
    DATABASE_URL: databaseUrl,
    INNGEST_BASE_URL: inngestBaseUrl,
    INNGEST_CONNECT_GATEWAY_URL: inngestConnectGatewayUrl,
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
