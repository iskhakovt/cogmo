#!/usr/bin/env node

import { command, flag, subcommands } from "cmd-ts";
import { choice, optionalOption } from "./cli/args.js";
import type { MigrationCliDeps } from "./cli/memory-migrations.js";
import type { MigrateSkillsRemoteCliDeps } from "./cli/migrate-skills-remote.js";
import { CONSOLE_IO, type CommandTree, loadCommandGroups, runCli } from "./cli/run.js";
import type { SkillsCliDeps } from "./cli/skills.js";
import { RESET_SCOPES, type ResetScope } from "./setup/reset-scopes.js";

// Each imports what it runs inside its handler, so `gen-key` and `web-token`
// work without a configured runtime.
const BUILT_INS = {
  serve: command({
    name: "serve",
    description: "Run the agent: Inngest worker, channel adapters and web UI.",
    args: {},
    handler: serve,
  }),
  seed: command({
    name: "seed",
    description: "Apply migrations and seed the default user, profile and channels.",
    args: {},
    handler: seedDefaults,
  }),
  setup: command({
    name: "setup",
    description: "Configure secrets, providers and channels.",
    args: {
      reset: optionalOption({
        long: "reset",
        type: choice(RESET_SCOPES, "scope"),
        description: `Clear stored state first: ${RESET_SCOPES.join(", ")}.`,
      }),
      nonInteractive: flag({
        long: "non-interactive",
        description: "Read the configuration from the environment instead of prompting.",
      }),
    },
    handler: setup,
  }),
  "gen-key": command({
    name: "gen-key",
    description: "Print a new COGMO_MASTER_KEY.",
    args: {},
    handler: genKey,
  }),
  "web-token": command({
    name: "web-token",
    description: "Print the web UI login token derived from COGMO_MASTER_KEY.",
    args: {},
    handler: webToken,
  }),
};

/** Command groups whose modules import the domain layer, imported on demand. */
const GROUPS: Record<string, () => Promise<CommandTree>> = {
  provider: async () => (await import("./cli/provider.js")).providerCli(CONSOLE_IO, loadCore),
  model: async () => (await import("./cli/model.js")).modelCli(CONSOLE_IO, loadCore),
  subagent: async () => (await import("./cli/subagent.js")).subAgentCli(CONSOLE_IO, loadCore),
  "image-provider": async () =>
    (await import("./cli/image-provider.js")).imageProviderCli(CONSOLE_IO, loadCore),
  "image-model": async () =>
    (await import("./cli/image-model.js")).imageModelCli(CONSOLE_IO, loadCore),
  skills: async () => (await import("./cli/skills.js")).skillsCli(CONSOLE_IO, loadSkillsDeps),
  "migrate-memories": async () =>
    (await import("./cli/memory-migrations.js")).migrateMemoriesCli(loadMigrationDeps),
  backfill: async () => (await import("./cli/memory-migrations.js")).backfillCli(loadMigrationDeps),
  "migrate-skills-remote": async () =>
    (await import("./cli/migrate-skills-remote.js")).migrateSkillsRemoteCli(loadSkillsRemoteDeps),
};

const argv = process.argv.length > 2 ? process.argv.slice(2) : ["serve"];
const cogmo = subcommands({
  name: "cogmo",
  description: "Personal agent runtime. With no command, runs `serve`.",
  cmds: await loadCommandGroups(argv, BUILT_INS, GROUPS),
});
process.exit(await runCli(cogmo, argv, CONSOLE_IO));

/**
 * Data layer only: no sandbox client, no instance row, no reaper — an admin
 * command is harmless alongside `cogmo serve`.
 */
async function loadCore() {
  const { bootstrapCore } = await import("./index.js");
  return bootstrapCore();
}

async function loadSkillsDeps(): Promise<SkillsCliDeps> {
  const { resolveSkillRunAs } = await import("./skills/run-as.js");
  const { bootstrapCore, bootstrapSkillRunner, NO_SANDBOX } = await import("./index.js");
  // Without the sandbox, tier-2 skill execution throws at call time; tier-1
  // skills and every admin subcommand run.
  const core = await bootstrapCore();
  const { skillRunner } = await bootstrapSkillRunner(core, NO_SANDBOX);
  return {
    runner: skillRunner,
    ownerRunAs: () => resolveSkillRunAs(core, { userId: core.user.id, profileId: core.profile.id }),
  };
}

async function loadMigrationDeps(): Promise<MigrationCliDeps> {
  const { verifyHindsight } = await import("./index.js");
  const { independentProbeContext } = await import("./boot/checks.js");
  const { env } = await import("./env.js");
  const core = await loadCore();
  const { agentStore, runInTx } = core;
  return {
    hindsightUrl: env.HINDSIGHT_URL,
    hindsightApiKey: env.HINDSIGHT_API_KEY,
    agentStore,
    runInTx,
    resolveDefaultBankId: async () => {
      const user = await runInTx((tx) => agentStore.getFirstUser(tx));
      return user ? user.id : null;
    },
    verifyHindsight: () => verifyHindsight(core, independentProbeContext()),
  };
}

async function loadSkillsRemoteDeps(): Promise<MigrateSkillsRemoteCliDeps> {
  const { env } = await import("./env.js");
  // The orchestrator re-reads `coding_repos` per delegation, so a running
  // `cogmo serve` picks up a new `remote_url` on its next task.
  const { runInTx, codingStore, secretsStore } = await loadCore();
  return { runInTx, codingStore, secretsStore, skillsRepoPath: env.COGMO_SKILLS_PATH };
}

async function seedDefaults(): Promise<number> {
  const { seed } = await import("./seed.js");
  await seed();
  return 0;
}

async function setup(args: {
  reset: ResetScope | undefined;
  nonInteractive: boolean;
}): Promise<number> {
  const { runSetup } = await import("./setup/index.js");
  await runSetup({
    ...(args.reset && { reset: args.reset }),
    ...(args.nonInteractive && { nonInteractive: true }),
  });
  return 0;
}

async function genKey(): Promise<number> {
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

async function webToken(): Promise<number> {
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

async function serve(): Promise<number> {
  const { connect } = await import("inngest/connect");
  const { createServer: createInngestServer } = await import("inngest/node");
  const { bootstrap } = await import("./index.js");
  const { env } = await import("./env.js");
  const { startWebServer } = await import("./web/server.js");
  const { verifyWebLoginToken } = await import("./web/auth/login-token.js");
  const { logger } = await import("./logger.js");
  const { SERVE_SHUTDOWN_BOUNDS, shutdownServe } = await import("./shutdown.js");

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
  const web = await startWebServer({
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
    await shutdownServe(
      {
        web,
        adapters,
        mcpRegistry,
        sandbox,
        closeInstance: sandboxInstanceId
          ? () => runInTx((tx) => sandboxStore.closeInstance(tx, sandboxInstanceId))
          : null,
      },
      SERVE_SHUTDOWN_BOUNDS,
    );
  }

  logger.info("cogmo stopped");
  return 0;
}
