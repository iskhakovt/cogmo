import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { DrizzleAgentStore } from "../agent/store/index.js";
import { bootstrapLock } from "../db/bootstrap-lock.js";
import { pinoNoticeHandler } from "../db/helpers.js";
import * as schema from "../db/schemas.js";
import { transactor } from "../db/transactor.js";
import { logger } from "../logger.js";
import { deriveMasterKey, parseMasterKey } from "../secrets/encryption.js";
import { resolveEnvFile } from "../secrets/env-file.js";
import { DrizzleSecretsStore } from "../secrets/store/index.js";
import { DrizzleTransportStore } from "../transport/store/index.js";
import { migrateAndSeed } from "./migrate-and-seed.js";
import {
  NonInteractiveValidationError,
  persistNonInteractive,
  SetupEnvError,
  validateNonInteractive,
} from "./non-interactive.js";
import type { ResetScope } from "./reset-scopes.js";
import { runWizard, WizardCancelled } from "./wizard.js";

export interface SetupOptions {
  reset?: ResetScope;
  nonInteractive?: boolean;
}

/**
 * Run the setup wizard or non-interactive setup.
 *
 * Handles its own DB connection (like `seed`), migrates and seeds defaults
 * (`migrateAndSeed`), then delegates to the interactive wizard or
 * non-interactive mode.
 */
export async function runSetup(opts: SetupOptions = {}): Promise<void> {
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
  const client = postgres(databaseUrl, { onnotice: pinoNoticeHandler });
  const db = drizzle({ client, schema });

  try {
    // For non-interactive: validate env + credentials before any DB mutation,
    // so a bad config can't trigger migrations or wipe state via --reset.
    let validatedNonInteractive = null;
    if (opts.nonInteractive) {
      const result = await validateNonInteractive(process.env);
      if (result.isErr()) {
        console.error(result.error.message);
        process.exitCode = 1;
        return;
      }
      validatedNonInteractive = result.value;
    }

    const tx = transactor(db);
    const lock = bootstrapLock(client);
    const agentStore = new DrizzleAgentStore();
    const transportStore = new DrizzleTransportStore();
    const encryptionKey = deriveMasterKey(parseMasterKey(masterKey), "cogmo/secrets-at-rest/v1");
    const secretsStore = new DrizzleSecretsStore(encryptionKey);

    const { userId } = await migrateAndSeed(
      { bootstrapLock: lock, db, runInTx: tx, agentStore, transportStore },
      { reset: opts.reset ?? null },
    );

    if (validatedNonInteractive) {
      await persistNonInteractive(
        { runInTx: tx, agentStore, transportStore, secretsStore },
        validatedNonInteractive,
        userId,
      );
      return;
    }

    await runWizard({ db, agentStore, transportStore, masterKey, userId, bootstrapLock: lock });
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
