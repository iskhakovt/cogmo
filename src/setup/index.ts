import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { DrizzleAgentStore } from "../agent/store/index.js";
import * as schema from "../db/schemas.js";
import { logger } from "../logger.js";
import { resolveEnvFile } from "../secrets/env-file.js";
import { DrizzleTransportStore } from "../transport/store/index.js";
import { seedDefaults } from "./seed.js";
import { runWizard, WizardCancelled } from "./wizard.js";

export interface SetupOptions {
  reset?: "secrets" | "channels" | "all";
  nonInteractive?: boolean;
}

const VALID_RESETS = new Set(["secrets", "channels", "all"]);

/**
 * Run the setup wizard or non-interactive setup.
 *
 * Handles its own DB connection (like `seed`), runs migrations,
 * then delegates to the interactive wizard or non-interactive mode.
 */
export async function runSetup(opts: SetupOptions = {}): Promise<void> {
  if (opts.reset && !VALID_RESETS.has(opts.reset)) {
    console.error(`Invalid --reset value: "${opts.reset}". Use: secrets, channels, or all`);
    process.exit(1);
  }

  // Master key is required for setup
  const masterKey = resolveEnvFile(process.env, "COGMO_MASTER_KEY");
  if (!masterKey) {
    console.error(
      "COGMO_MASTER_KEY is required for setup.\n" +
        "Generate one with: cogmo gen-key\n" +
        "Then set it in your environment (docker-compose.yml, systemd, etc.)",
    );
    process.exit(1);
  }

  const databaseUrl =
    resolveEnvFile(process.env, "DATABASE_URL") ?? "postgresql://cogmo@localhost/cogmo";
  const db = drizzle({ connection: databaseUrl, schema });

  try {
    await migrate(db, { migrationsFolder: "./migrations" });
    logger.info("migrations applied");

    const agentStore = new DrizzleAgentStore(db);
    const transportStore = new DrizzleTransportStore(db);

    // Handle --reset before anything else (including non-interactive)
    if (opts.reset === "all" || opts.reset === "secrets") {
      const { deriveMasterKey, parseMasterKey } = await import("../secrets/encryption.js");
      const { DrizzleSecretsStore } = await import("../secrets/store/index.js");
      const encryptionKey = deriveMasterKey(parseMasterKey(masterKey), "cogmo/secrets-at-rest/v1");
      const secretsStore = new DrizzleSecretsStore(db, encryptionKey);
      await secretsStore.deleteAllSecrets();
      logger.info("all secrets deleted");
    }
    if (opts.reset === "all" || opts.reset === "channels") {
      const allChannels = await transportStore.getAllChannels();
      for (const ch of allChannels) {
        if (ch.type !== "direct") {
          await transportStore.removeChannel(ch.id);
        }
      }
      logger.info("non-direct channels removed");
    }

    if (opts.nonInteractive) {
      await seedDefaults(agentStore, transportStore);
      logger.info("non-interactive setup complete (seed only)");
      return;
    }

    await runWizard({ db, agentStore, transportStore, masterKey });
  } catch (err) {
    if (err instanceof WizardCancelled) {
      logger.info("setup cancelled by user");
      return;
    }
    throw err;
  } finally {
    await db.$client.end();
  }
}

export { seedDefaults } from "./seed.js";
