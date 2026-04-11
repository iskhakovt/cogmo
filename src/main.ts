#!/usr/bin/env node

const command = process.argv[2] ?? "serve";

switch (command) {
  case "serve":
    await main();
    break;
  case "seed": {
    const { seed } = await import("./seed.js");
    await seed();
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Usage: main.js [serve|seed]");
    process.exit(1);
}

async function main() {
  const { connect } = await import("inngest/connect");
  const { createServer: createInngestServer } = await import("inngest/node");
  const { bootstrap } = await import("./index.js");
  const { env } = await import("./env.js");
  const { logger } = await import("./logger.js");

  const { inngest, functions, adapters } = await bootstrap();

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
  }

  logger.info("cogmo stopped");
}
