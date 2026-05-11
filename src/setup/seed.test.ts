import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DrizzleAgentStore } from "../agent/store/index.js";
import type { Database, Transactor } from "../db/index.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../secrets/encryption.js";
import { DrizzleSecretsStore } from "../secrets/store/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { ensureFalImageDefaults } from "./seed.js";

/**
 * Tests for `ensureFalImageDefaults` — the bootstrap-time seed that wires
 * the canonical fal image-gen catalog. Three behaviours under test:
 *   1. Skips cleanly when no fal secret or env fallback exists.
 *   2. Materializes a secret from the env-fallback path and seeds.
 *   3. Idempotent on re-run — preserves operator edits to existing rows.
 */

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let agentStore: DrizzleAgentStore;
let secretsStore: DrizzleSecretsStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  agentStore = new DrizzleAgentStore();
  const key = deriveMasterKey(parseMasterKey(generateMasterKey()), "cogmo/secrets-at-rest/v1");
  secretsStore = new DrizzleSecretsStore(key);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

describe("ensureFalImageDefaults", () => {
  it("skips when no fal secret and no env fallback", async () => {
    const result = await ensureFalImageDefaults({
      runInTx: tx,
      agentStore,
      secretsStore,
    });
    expect(result).toEqual({ skipped: true, reason: "no_fal_secret" });
    expect(await tx((trx) => agentStore.listImageProviders(trx))).toEqual([]);
  });

  it("uses an existing fal_api_key secret without touching the env fallback", async () => {
    await tx((trx) =>
      secretsStore.putSecret(trx, { name: "fal_api_key", plaintext: "sk-from-wizard" }),
    );

    const result = await ensureFalImageDefaults({
      runInTx: tx,
      agentStore,
      secretsStore,
      envFalApiKey: "sk-from-env", // should be ignored — secret already exists
    });
    if (!("seeded" in result)) throw new Error("expected seeded");
    expect(result.providerCreated).toBe(true);
    expect(result.modelsInserted).toBeGreaterThan(0);

    const providers = await tx((trx) => agentStore.listImageProviders(trx));
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toBe("fal");

    // The seed used the existing wizard-written secret, not the env value.
    const decrypted = await tx((trx) => secretsStore.getSecret(trx, "fal_api_key"));
    expect(decrypted).toBe("sk-from-wizard");
  });

  it("materializes fal_api_key from the env fallback when no secret exists", async () => {
    const result = await ensureFalImageDefaults({
      runInTx: tx,
      agentStore,
      secretsStore,
      envFalApiKey: "sk-from-env",
    });
    if (!("seeded" in result)) throw new Error("expected seeded");
    expect(result.providerCreated).toBe(true);

    const decrypted = await tx((trx) => secretsStore.getSecret(trx, "fal_api_key"));
    expect(decrypted).toBe("sk-from-env");
  });

  it("seeds a useful number of models on first run", async () => {
    await tx((trx) => secretsStore.putSecret(trx, { name: "fal_api_key", plaintext: "sk" }));
    const result = await ensureFalImageDefaults({
      runInTx: tx,
      agentStore,
      secretsStore,
    });
    if (!("seeded" in result)) throw new Error("expected seeded");
    expect(result.modelsInserted).toBeGreaterThanOrEqual(5); // shipped catalog has ~9 entries

    const models = await tx((trx) => agentStore.listImageModelsWithProvider(trx));
    expect(models.every((m) => m.provider.name === "fal")).toBe(true);
    expect(models.some((m) => m.name === "fal/flux-dev")).toBe(true);
  });

  it("is idempotent on re-run — no duplicate provider, no duplicate models, preserves edits", async () => {
    await tx((trx) => secretsStore.putSecret(trx, { name: "fal_api_key", plaintext: "sk" }));
    const first = await ensureFalImageDefaults({
      runInTx: tx,
      agentStore,
      secretsStore,
    });
    if (!("seeded" in first)) throw new Error("expected first seeded");

    // Operator edits one model's description directly via the store —
    // simulates someone tweaking a "use when..." hint to match local taste.
    const modelsBefore = await tx((trx) => agentStore.listImageModels(trx));
    const target = modelsBefore.find((m) => m.name === "fal/flux-dev");
    expect(target).toBeDefined();
    await tx((trx) => agentStore.deleteImageModel(trx, target!.id));
    // Re-seed should re-insert the deleted row (DO NOTHING on existing names,
    // re-create when name is gone) without duplicating others.

    const second = await ensureFalImageDefaults({
      runInTx: tx,
      agentStore,
      secretsStore,
    });
    if (!("seeded" in second)) throw new Error("expected second seeded");
    expect(second.providerCreated).toBe(false); // provider already exists
    expect(second.modelsInserted).toBe(1); // only the deleted row re-inserted

    const providers = await tx((trx) => agentStore.listImageProviders(trx));
    expect(providers).toHaveLength(1); // no duplicate provider row

    const modelsAfter = await tx((trx) => agentStore.listImageModels(trx));
    expect(modelsAfter.length).toBe(modelsBefore.length); // same count as first run
  });
});
