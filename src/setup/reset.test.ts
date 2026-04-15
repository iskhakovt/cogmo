/**
 * Unit tests for `applyReset`.
 * PGlite-backed — exercises the real store queries.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DrizzleAgentStore } from "../agent/store/index.js";
import type { Database } from "../db/index.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../secrets/encryption.js";
import { DrizzleSecretsStore } from "../secrets/store/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { DrizzleTransportStore } from "../transport/store/index.js";
import { applyReset } from "./reset.js";
import { ensureDefaultUser, ensureDirectChannel } from "./seed.js";

let db: Database;
let close: () => Promise<void>;
let agentStore: DrizzleAgentStore;
let transportStore: DrizzleTransportStore;
let secretsStore: DrizzleSecretsStore;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  agentStore = new DrizzleAgentStore(db);
  transportStore = new DrizzleTransportStore(db);
  const key = deriveMasterKey(parseMasterKey(generateMasterKey()), "cogmo/secrets-at-rest/v1");
  secretsStore = new DrizzleSecretsStore(db, key);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

describe("applyReset", () => {
  it("secrets: deletes all secrets, leaves channels untouched", async () => {
    await secretsStore.putSecret({ name: "llm_key", plaintext: "abc" });
    await secretsStore.putSecret({ name: "tg_key", plaintext: "def" });
    const userId = await ensureDefaultUser(agentStore);
    await ensureDirectChannel(transportStore, userId);
    await transportStore.createChannel({
      type: "telegram",
      credentials: { tokenSecretName: "tg_key" },
      identityMode: "mapped",
    });

    await applyReset("secrets", { secretsStore, transportStore });

    expect(await secretsStore.listSecrets()).toHaveLength(0);
    expect(await transportStore.getAllChannels()).toHaveLength(2); // direct + telegram
  });

  it("channels: removes non-direct channels only; direct channel survives", async () => {
    const userId = await ensureDefaultUser(agentStore);
    await ensureDirectChannel(transportStore, userId);
    await transportStore.createChannel({
      type: "telegram",
      credentials: {},
      identityMode: "mapped",
    });
    await secretsStore.putSecret({ name: "llm_key", plaintext: "abc" });

    await applyReset("channels", { secretsStore, transportStore });

    const channels = await transportStore.getAllChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]?.type).toBe("direct");
    // Secrets untouched
    expect(await secretsStore.listSecrets()).toHaveLength(1);
  });

  it("all: deletes secrets and non-direct channels in one call", async () => {
    const userId = await ensureDefaultUser(agentStore);
    await ensureDirectChannel(transportStore, userId);
    await transportStore.createChannel({
      type: "telegram",
      credentials: {},
      identityMode: "mapped",
    });
    await secretsStore.putSecret({ name: "k1", plaintext: "v1" });

    await applyReset("all", { secretsStore, transportStore });

    expect(await secretsStore.listSecrets()).toHaveLength(0);
    const channels = await transportStore.getAllChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]?.type).toBe("direct");
  });

  it("no-ops cleanly when nothing has been seeded yet", async () => {
    await expect(applyReset("all", { secretsStore, transportStore })).resolves.toBeUndefined();
    expect(await secretsStore.listSecrets()).toHaveLength(0);
    expect(await transportStore.getAllChannels()).toHaveLength(0);
  });
});
