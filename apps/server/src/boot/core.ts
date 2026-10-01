/**
 * Stage 1: the data layer. Migrations, stores, secrets, object storage, tool
 * credentials, the LLM provider resolver, the boot user/profile pair and the
 * Hindsight client.
 */

import type { DrizzleAgentStore } from "../agent/store/index.js";
import { bootstrapLock } from "../db/bootstrap-lock.js";
import { db, type Transactor, transactor } from "../db/index.js";
import { env } from "../env.js";
import { deriveMasterKey, parseMasterKey } from "../secrets/encryption.js";
import { DrizzleSecretsStore } from "../secrets/store/index.js";
import { deriveWebLoginToken } from "../web/auth/login-token.js";
import { createProviderResolver } from "./llm.js";
import { prepareDataLayer } from "./locked-bootstrap.js";
import { createMemory } from "./memory.js";
import type { BootstrapOptions, CoreDeps } from "./stages.js";
import { createObjectStorage } from "./storage.js";
import { createStores } from "./stores.js";

/**
 * Constructs no sandbox, registers no Inngest functions, starts no background
 * work — concurrent invocations with `cogmo serve` can't reap each other's
 * sandboxes, which is the specific race this stage was carved out to prevent.
 * Migrations and the skills-repo bootstrap run under the bootstrap lock
 * (`prepareDataLayer`), so parallel invocations apply them one at a time.
 */
export async function bootstrapCore(opts: BootstrapOptions = {}): Promise<CoreDeps> {
  const tx = transactor(db);
  const lock = bootstrapLock(db.$client);
  const stores = createStores();

  await prepareDataLayer(
    { bootstrapLock: lock, db, runInTx: tx, codingStore: stores.codingStore },
    { skillsRepoPath: env.COGMO_SKILLS_PATH },
  );

  if (!env.COGMO_MASTER_KEY) {
    throw new Error(
      "COGMO_MASTER_KEY is required. Generate one with: cogmo gen-key\n" + "Then run: cogmo setup",
    );
  }
  const secretsStore = new DrizzleSecretsStore(
    deriveMasterKey(parseMasterKey(env.COGMO_MASTER_KEY), "cogmo/secrets-at-rest/v1"),
  );
  // Derived bootstrap login token for the web UI — nothing persisted; the gate
  // recomputes + constant-time-compares the presented value.
  const webLoginToken = deriveWebLoginToken(env.COGMO_MASTER_KEY);

  const { user, profile } = await loadBootIdentity(tx, stores.agentStore);

  const resolveProvider = createProviderResolver(
    { runInTx: tx, agentStore: stores.agentStore, secretsStore },
    opts,
  );

  const storage = createObjectStorage(env.COGMO_MASTER_KEY);

  // Tool credentials: DB first (wizard-configured), env fallback (dev convenience).
  const tavilyKey =
    (await tx((trx) => secretsStore.getSecret(trx, "tavily_api_key"))) ?? env.TAVILY_API_KEY;
  const openrouterKey =
    (await tx((trx) => secretsStore.getSecret(trx, "openrouter_api_key"))) ??
    env.OPENROUTER_API_KEY;
  const { memory, hindsightCompat } = createMemory();

  return {
    db,
    runInTx: tx,
    bootstrapLock: lock,
    ...stores,
    secretsStore,
    webLoginToken,
    ...storage,
    tavilyKey,
    openrouterKey,
    resolveProvider,
    user,
    profile,
    memory,
    hindsightCompat,
  };
}

/** The user and default profile every boot runs as; `cogmo setup` seeds them. */
async function loadBootIdentity(
  runInTx: Transactor,
  agentStore: DrizzleAgentStore,
): Promise<{ user: { id: string }; profile: { id: string } }> {
  return runInTx(async (trx) => {
    const u = await agentStore.getFirstUser(trx);
    const defaultProfile = await agentStore.getDefaultProfile(trx);
    if (!u || !defaultProfile) {
      throw new Error("no user or profile found — run `cogmo setup` first");
    }
    const p = await agentStore.getProfile(trx, defaultProfile.id);
    if (!p) {
      throw new Error("default profile disappeared — database inconsistency");
    }
    return { user: u, profile: p };
  });
}
