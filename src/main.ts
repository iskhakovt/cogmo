#!/usr/bin/env node

const command = process.argv[2] ?? "serve";
process.exit(await dispatch(command));

async function dispatch(cmd: string): Promise<number> {
  switch (cmd) {
    case "serve":
      await main();
      return 0;
    case "seed": {
      const { seed } = await import("./seed.js");
      await seed();
      return 0;
    }
    case "setup": {
      const { runSetup } = await import("./setup/index.js");
      const args = process.argv.slice(3);
      const resetIdx = args.indexOf("--reset");
      const reset =
        resetIdx >= 0 ? (args[resetIdx + 1] as "secrets" | "channels" | "all") : undefined;
      const nonInteractive = args.includes("--non-interactive");
      await runSetup({ ...(reset && { reset }), ...(nonInteractive && { nonInteractive }) });
      return 0;
    }
    case "gen-key": {
      const { generateMasterKey } = await import("./secrets/encryption.js");
      const key = generateMasterKey();
      console.log(`COGMO_MASTER_KEY=${key}`);
      console.log(
        "# Add this to your docker-compose.yml environment block,\n" +
          "# or write to a Docker secret and set COGMO_MASTER_KEY_FILE.\n" +
          "# This key encrypts all credentials in the database.\n" +
          "# Store it securely — losing it means re-entering all credentials.",
      );
      return 0;
    }
    case "skills": {
      const { runSkillsCli } = await import("./skills/cli.js");
      const { bootstrapCore, bootstrapSkillRunner, NO_SANDBOX } = await import("./index.js");
      // CLI mode: skip bootstrapSandbox (no instance row, no
      // reconcileCrashedInstances). Tier-2 skill execution requires the
      // sandbox and will throw at call time; tier-1 skills + every admin
      // subcommand (list / register / approve / deny / rollback /
      // deregister) run fine.
      const core = await bootstrapCore();
      const { skillRunner } = await bootstrapSkillRunner(core, NO_SANDBOX);
      return runSkillsCli(process.argv.slice(3), skillRunner);
    }
    case "migrate-memories":
    case "backfill": {
      const { runMigrateMemoriesCli, runBackfillProfileClassCli } = await import(
        "./agent/evolution/migrations-cli.js"
      );
      const { bootstrapCore } = await import("./index.js");
      const { env } = await import("./env.js");
      // CLI mode: data layer only. No sandbox client, no instance row, no
      // reaper — running this concurrently with `cogmo serve` is harmless.
      const { agentStore, runInTx } = await bootstrapCore();
      const resolveDefaultBankId = async (): Promise<string | null> => {
        const user = await runInTx((tx) => agentStore.getFirstUser(tx));
        return user ? user.id : null;
      };
      const cliDeps = {
        hindsightUrl: env.HINDSIGHT_URL,
        agentStore,
        runInTx,
        resolveDefaultBankId,
      };
      const args = process.argv.slice(3);
      return cmd === "migrate-memories"
        ? runMigrateMemoriesCli(args, cliDeps)
        : runBackfillProfileClassCli(args, cliDeps);
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error("Usage: main.js [serve|seed|setup|gen-key|skills|migrate-memories|backfill]");
      return 1;
  }
}

async function main() {
  const { connect } = await import("inngest/connect");
  const { createServer: createInngestServer } = await import("inngest/node");
  const { bootstrap } = await import("./index.js");
  const { env } = await import("./env.js");
  const { startHealthServer } = await import("./health.js");
  const { logger } = await import("./logger.js");

  const {
    inngest,
    functions,
    adapters,
    sandbox,
    sandboxStore,
    sandboxInstanceId,
    mcpRegistry,
    runInTx,
  } = await bootstrap();
  const healthServer = await startHealthServer();

  try {
    if (env.INNGEST_MODE === "serve") {
      const server = createInngestServer({ client: inngest, functions });
      await new Promise<void>((resolve) => server.listen(env.INNGEST_SERVE_PORT, resolve));
      logger.info({ port: env.INNGEST_SERVE_PORT }, "inngest connected");

      await new Promise<void>((resolve) => {
        const shutdown = () => {
          server.close();
          resolve();
        };
        process.on("SIGTERM", shutdown);
        process.on("SIGINT", shutdown);
      });
    } else {
      const connection = await connect({
        apps: [{ client: inngest, functions }],
        handleShutdownSignals: ["SIGTERM", "SIGINT"],
      });
      logger.info({ connectionId: connection.connectionId }, "inngest connected");
      logger.info("cogmo ready — use `pnpm console` to interact");
      await connection.closed;
    }
  } finally {
    for (const adapter of adapters) {
      await adapter.stop();
    }
    if (mcpRegistry) await mcpRegistry.stop();
    if (sandbox) await sandbox.shutdown();
    if (sandboxInstanceId) {
      await runInTx((tx) => sandboxStore.closeInstance(tx, sandboxInstanceId));
    }
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  }

  logger.info("cogmo stopped");
}
