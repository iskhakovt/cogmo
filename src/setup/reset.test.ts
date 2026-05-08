/**
 * Unit tests for `applyReset`.
 * PGlite-backed — exercises the real store queries.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DrizzleAgentStore } from "../agent/store/index.js";
import type { Database, Transactor } from "../db/index.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../secrets/encryption.js";
import { DrizzleSecretsStore } from "../secrets/store/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { DrizzleTransportStore } from "../transport/store/index.js";
import { applyReset } from "./reset.js";
import { ensureDefaultUser, ensureDirectChannel } from "./seed.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let agentStore: DrizzleAgentStore;
let transportStore: DrizzleTransportStore;
let secretsStore: DrizzleSecretsStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  agentStore = new DrizzleAgentStore();
  transportStore = new DrizzleTransportStore();
  const key = deriveMasterKey(parseMasterKey(generateMasterKey()), "cogmo/secrets-at-rest/v1");
  secretsStore = new DrizzleSecretsStore(key);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

describe("applyReset", () => {
  it("secrets: deletes all secrets, leaves channels untouched", async () => {
    await tx((trx) => secretsStore.putSecret(trx, { name: "llm_key", plaintext: "abc" }));
    await tx((trx) => secretsStore.putSecret(trx, { name: "tg_key", plaintext: "def" }));
    const userId = await ensureDefaultUser(tx, agentStore);
    await ensureDirectChannel(tx, transportStore, userId);
    await tx((trx) =>
      transportStore.createChannel(trx, {
        type: "telegram",
        credentials: { tokenSecretName: "tg_key" },
        identityMode: "mapped",
      }),
    );

    await applyReset("secrets", { db });

    expect(await tx((trx) => secretsStore.listSecrets(trx))).toHaveLength(0);
    expect(await tx((trx) => transportStore.getAllChannels(trx))).toHaveLength(2); // direct + telegram
  });

  it("channels: removes non-direct channels only; direct channel survives", async () => {
    const userId = await ensureDefaultUser(tx, agentStore);
    await ensureDirectChannel(tx, transportStore, userId);
    await tx((trx) =>
      transportStore.createChannel(trx, {
        type: "telegram",
        credentials: {},
        identityMode: "mapped",
      }),
    );
    await tx((trx) => secretsStore.putSecret(trx, { name: "llm_key", plaintext: "abc" }));

    await applyReset("channels", { db });

    const channels = await tx((trx) => transportStore.getAllChannels(trx));
    expect(channels).toHaveLength(1);
    expect(channels[0]?.type).toBe("direct");
    // Secrets untouched
    expect(await tx((trx) => secretsStore.listSecrets(trx))).toHaveLength(1);
  });

  it("all: deletes secrets and non-direct channels in one call", async () => {
    const userId = await ensureDefaultUser(tx, agentStore);
    await ensureDirectChannel(tx, transportStore, userId);
    await tx((trx) =>
      transportStore.createChannel(trx, {
        type: "telegram",
        credentials: {},
        identityMode: "mapped",
      }),
    );
    await tx((trx) => secretsStore.putSecret(trx, { name: "k1", plaintext: "v1" }));

    await applyReset("all", { db });

    expect(await tx((trx) => secretsStore.listSecrets(trx))).toHaveLength(0);
    const channels = await tx((trx) => transportStore.getAllChannels(trx));
    expect(channels).toHaveLength(1);
    expect(channels[0]?.type).toBe("direct");
  });

  it("no-ops cleanly when nothing has been seeded yet", async () => {
    await expect(applyReset("all", { db })).resolves.toBeUndefined();
    expect(await tx((trx) => secretsStore.listSecrets(trx))).toHaveLength(0);
    expect(await tx((trx) => transportStore.getAllChannels(trx))).toHaveLength(0);
  });
});
