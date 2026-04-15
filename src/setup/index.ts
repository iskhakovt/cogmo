import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { DrizzleAgentStore } from "../agent/store/index.js";
import * as schema from "../db/schemas.js";
import { logger } from "../logger.js";
import { deriveMasterKey, parseMasterKey } from "../secrets/encryption.js";
import { resolveEnvFile } from "../secrets/env-file.js";
import { DrizzleSecretsStore } from "../secrets/store/index.js";
import { DrizzleTransportStore } from "../transport/store/index.js";
import {
  NonInteractiveValidationError,
  runNonInteractive,
  SetupEnvError,
} from "./non-interactive.js";
import { applyReset, type ResetScope, VALID_RESETS } from "./reset.js";
import { runWizard, WizardCancelled } from "./wizard.js";

export interface SetupOptions {
  reset?: ResetScope;
  nonInteractive?: boolean;
}

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
    const encryptionKey = deriveMasterKey(parseMasterKey(masterKey), "cogmo/secrets-at-rest/v1");
    const secretsStore = new DrizzleSecretsStore(db, encryptionKey);

    // Handle --reset before anything else (including non-interactive)
    if (opts.reset) {
      await applyReset(opts.reset, { db });
    }

    if (opts.nonInteractive) {
      await runNonInteractive({
        agentStore,
        transportStore,
        secretsStore,
        env: process.env,
      });
      return;
    }

    await runWizard({ db, agentStore, transportStore, masterKey });
  } catch (err) {
    if (err instanceof WizardCancelled) {
      logger.info("setup cancelled by user");
      return;
    }
    if (err instanceof SetupEnvError || err instanceof NonInteractiveValidationError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    await db.$client.end();
  }
}

export { seedDefaults } from "./seed.js";
