import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../encryption.js";
import { DrizzleSecretsStore } from "./index.js";

const PURPOSE = "cogmo/secrets-at-rest/v1";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleSecretsStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  const key = deriveMasterKey(parseMasterKey(generateMasterKey()), PURPOSE);
  store = new DrizzleSecretsStore(key);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

describe("DrizzleSecretsStore", () => {
  describe("putSecret / getSecret", () => {
    it("stores and retrieves a secret", async () => {
      await tx((trx) => store.putSecret(trx, { name: "api_key", plaintext: "sk-test-123" }));
      const value = await tx((trx) => store.getSecret(trx, "api_key"));
      expect(value).toBe("sk-test-123");
    });

    it("returns undefined for missing secret", async () => {
      const value = await tx((trx) => store.getSecret(trx, "nonexistent"));
      expect(value).toBeUndefined();
    });

    it("upserts on duplicate name", async () => {
      await tx((trx) => store.putSecret(trx, { name: "api_key", plaintext: "old-value" }));
      await tx((trx) => store.putSecret(trx, { name: "api_key", plaintext: "new-value" }));
      const value = await tx((trx) => store.getSecret(trx, "api_key"));
      expect(value).toBe("new-value");
    });

    it("preserves description on upsert", async () => {
      await tx((trx) =>
        store.putSecret(trx, {
          name: "api_key",
          plaintext: "v1",
          description: "Main API key",
        }),
      );
      await tx((trx) => store.putSecret(trx, { name: "api_key", plaintext: "v2" }));
      const meta = await tx((trx) => store.getSecretMeta(trx, "api_key"));
      expect(meta?.description).toBe("Main API key");
    });

    it("updates description on upsert when provided", async () => {
      await tx((trx) =>
        store.putSecret(trx, {
          name: "api_key",
          plaintext: "v1",
          description: "Old desc",
        }),
      );
      await tx((trx) =>
        store.putSecret(trx, {
          name: "api_key",
          plaintext: "v2",
          description: "New desc",
        }),
      );
      const meta = await tx((trx) => store.getSecretMeta(trx, "api_key"));
      expect(meta?.description).toBe("New desc");
    });
  });

  describe("getSecretById", () => {
    it("retrieves a secret by ID", async () => {
      const { id } = await tx((trx) =>
        store.putSecret(trx, { name: "by_id", plaintext: "secret-val" }),
      );
      const value = await tx((trx) => store.getSecretById(trx, id));
      expect(value).toBe("secret-val");
    });

    it("returns undefined for missing ID", async () => {
      const value = await tx((trx) =>
        store.getSecretById(trx, "019d0000-0000-7000-8000-000000000099"),
      );
      expect(value).toBeUndefined();
    });
  });

  describe("getSecretMeta", () => {
    it("returns metadata without the value", async () => {
      const { id } = await tx((trx) =>
        store.putSecret(trx, {
          name: "meta_test",
          plaintext: "should-not-appear",
          description: "Test key",
        }),
      );
      const meta = await tx((trx) => store.getSecretMeta(trx, "meta_test"));
      expect(meta).toEqual({
        id,
        name: "meta_test",
        description: "Test key",
        validatedAt: null,
      });
      // Ensure plaintext is NOT in the result
      expect(meta).not.toHaveProperty("plaintext");
      expect(meta).not.toHaveProperty("ciphertext");
    });
  });

  describe("listSecrets", () => {
    it("returns all secret names", async () => {
      await tx((trx) => store.putSecret(trx, { name: "key_a", plaintext: "a" }));
      await tx((trx) => store.putSecret(trx, { name: "key_b", plaintext: "b" }));
      const list = await tx((trx) => store.listSecrets(trx));
      const names = list.map((s) => s.name).sort();
      expect(names).toEqual(["key_a", "key_b"]);
    });

    it("returns empty array when no secrets", async () => {
      const list = await tx((trx) => store.listSecrets(trx));
      expect(list).toEqual([]);
    });
  });

  describe("markValidated", () => {
    it("sets validatedAt timestamp", async () => {
      await tx((trx) => store.putSecret(trx, { name: "validated", plaintext: "v" }));
      const before = await tx((trx) => store.getSecretMeta(trx, "validated"));
      expect(before?.validatedAt).toBeNull();

      await tx((trx) => store.markValidated(trx, "validated"));

      const after = await tx((trx) => store.getSecretMeta(trx, "validated"));
      expect(after?.validatedAt).toBeInstanceOf(Date);
    });
  });

  describe("deleteSecret", () => {
    it("removes a secret by name", async () => {
      await tx((trx) => store.putSecret(trx, { name: "to_delete", plaintext: "gone" }));
      await tx((trx) => store.deleteSecret(trx, "to_delete"));
      const value = await tx((trx) => store.getSecret(trx, "to_delete"));
      expect(value).toBeUndefined();
    });
  });

  describe("deleteAllSecrets", () => {
    it("removes all secrets", async () => {
      await tx((trx) => store.putSecret(trx, { name: "a", plaintext: "1" }));
      await tx((trx) => store.putSecret(trx, { name: "b", plaintext: "2" }));
      await tx((trx) => store.deleteAllSecrets(trx));
      const list = await tx((trx) => store.listSecrets(trx));
      expect(list).toEqual([]);
    });
  });
});
