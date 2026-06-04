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
    case "web-token": {
      // Read the master key directly (with the `_FILE` convention) rather than
      // the full env — like `gen-key`, this prints standalone without a
      // configured runtime (no DB / Inngest / Hindsight URLs needed).
      const { resolveEnvFile } = await import("./secrets/env-file.js");
      const masterKey = resolveEnvFile(process.env, "COGMO_MASTER_KEY");
      if (!masterKey) {
        console.error("COGMO_MASTER_KEY is required. Generate one with: cogmo gen-key");
        return 1;
      }
      const { deriveWebLoginToken } = await import("./web/auth/login-token.js");
      console.log(deriveWebLoginToken(masterKey));
      console.log(
        "# Paste this token into the web UI login to mint a session cookie.\n" +
          "# Derived from COGMO_MASTER_KEY — stored nowhere, safe to reprint.\n" +
          "# Rotate by bumping the purpose version in src/web/auth/login-token.ts.",
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
    case "provider": {
      const { runProviderCli } = await import("./cli/provider.js");
      const { bootstrapCore } = await import("./index.js");
      const { agentStore, runInTx, secretsStore } = await bootstrapCore();
      return runProviderCli(process.argv.slice(3), { agentStore, runInTx, secretsStore });
    }
    case "model": {
      const { runModelCli } = await import("./cli/model.js");
      const { bootstrapCore } = await import("./index.js");
      const { agentStore, runInTx } = await bootstrapCore();
      return runModelCli(process.argv.slice(3), { agentStore, runInTx });
    }
    case "subagent": {
      const { runSubAgentCli } = await import("./cli/subagent.js");
      const { bootstrapCore } = await import("./index.js");
      const { agentStore, runInTx } = await bootstrapCore();
      return runSubAgentCli(process.argv.slice(3), { agentStore, runInTx });
    }
    case "image-provider": {
      const { runImageProviderCli } = await import("./cli/image-provider.js");
      const { bootstrapCore } = await import("./index.js");
      const { agentStore, runInTx, secretsStore } = await bootstrapCore();
      return runImageProviderCli(process.argv.slice(3), { agentStore, runInTx, secretsStore });
    }
    case "image-model": {
      const { runImageModelCli } = await import("./cli/image-model.js");
      const { bootstrapCore } = await import("./index.js");
      const { agentStore, runInTx } = await bootstrapCore();
      return runImageModelCli(process.argv.slice(3), { agentStore, runInTx });
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
    case "migrate-skills-remote": {
      const { runMigrateSkillsRemoteCli } = await import("./skills/migrations-cli.js");
      const { bootstrapCore } = await import("./index.js");
      const { env } = await import("./env.js");
      // Same data-layer-only bootstrap as `migrate-memories`. Safe to run
      // alongside `cogmo serve` — the orchestrator re-reads `coding_repos`
      // per delegation, so any updated `remote_url` is picked up on the
      // next task without a daemon restart.
      const { runInTx, codingStore, secretsStore } = await bootstrapCore();
      return runMigrateSkillsRemoteCli(process.argv.slice(3), {
        runInTx,
        codingStore,
        secretsStore,
        skillsRepoPath: env.COGMO_SKILLS_PATH,
      });
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error(
        "Usage: main.js [serve|seed|setup|gen-key|web-token|provider|model|subagent|image-provider|image-model|skills|migrate-memories|backfill|migrate-skills-remote]",
      );
      return 1;
  }
}

async function main() {
  const { connect } = await import("inngest/connect");
  const { createServer: createInngestServer } = await import("inngest/node");
  const { bootstrap } = await import("./index.js");
  const { env } = await import("./env.js");
  const { startWebServer } = await import("./web/server.js");
  const { verifyWebLoginToken } = await import("./web/auth/login-token.js");
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
    webTransport,
    webSessionStore,
    webStreamRegistry,
    webLoginToken,
    user,
  } = await bootstrap();
  const webServer = await startWebServer({
    webTransport,
    webSessionStore,
    webStreamRegistry,
    runInTx,
    verifyLoginToken: (candidate) => verifyWebLoginToken(candidate, webLoginToken),
    ownerUserId: user.id,
    sessionTtlDays: env.WEB_SESSION_TTL_DAYS,
    cookieSecure: !env.WEB_INSECURE_COOKIES,
    staticRoot: env.WEB_STATIC_ROOT,
    webDevAllowOrigin: env.WEB_DEV_ALLOW_ORIGIN ?? null,
    host: env.WEB_HOST,
    port: env.WEB_PORT,
  });

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
    // Drain HTTP first — stop accepting requests before the Transport and
    // stores the oRPC layer depends on are torn down. `closeIdleConnections`
    // drops idle keep-alive sockets (a browser holding one open would otherwise
    // make `close()` wait indefinitely); in-flight requests still drain.
    await new Promise<void>((resolve) => {
      webServer.close(() => resolve());
      webServer.closeIdleConnections();
    });
    for (const adapter of adapters) {
      await adapter.stop();
    }
    if (mcpRegistry) await mcpRegistry.stop();
    if (sandbox) await sandbox.shutdown();
    if (sandboxInstanceId) {
      await runInTx((tx) => sandboxStore.closeInstance(tx, sandboxInstanceId));
    }
  }

  logger.info("cogmo stopped");
}
