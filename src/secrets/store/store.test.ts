import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../db/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../encryption.js";
import { DrizzleSecretsStore } from "./index.js";

const PURPOSE = "cogmo/secrets-at-rest/v1";

let db: Database;
let close: () => Promise<void>;
let store: DrizzleSecretsStore;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  const key = deriveMasterKey(parseMasterKey(generateMasterKey()), PURPOSE);
  store = new DrizzleSecretsStore(db, key);
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
      await store.putSecret({ name: "api_key", plaintext: "sk-test-123" });
      const value = await store.getSecret("api_key");
      expect(value).toBe("sk-test-123");
    });

    it("returns null for missing secret", async () => {
      const value = await store.getSecret("nonexistent");
      expect(value).toBeNull();
    });

    it("upserts on duplicate name", async () => {
      await store.putSecret({ name: "api_key", plaintext: "old-value" });
      await store.putSecret({ name: "api_key", plaintext: "new-value" });
      const value = await store.getSecret("api_key");
      expect(value).toBe("new-value");
    });

    it("preserves description on upsert", async () => {
      await store.putSecret({
        name: "api_key",
        plaintext: "v1",
        description: "Main API key",
      });
      await store.putSecret({ name: "api_key", plaintext: "v2" });
      const meta = await store.getSecretMeta("api_key");
      expect(meta?.description).toBe("Main API key");
    });

    it("updates description on upsert when provided", async () => {
      await store.putSecret({
        name: "api_key",
        plaintext: "v1",
        description: "Old desc",
      });
      await store.putSecret({
        name: "api_key",
        plaintext: "v2",
        description: "New desc",
      });
      const meta = await store.getSecretMeta("api_key");
      expect(meta?.description).toBe("New desc");
    });
  });

  describe("getSecretById", () => {
    it("retrieves a secret by ID", async () => {
      const { id } = await store.putSecret({ name: "by_id", plaintext: "secret-val" });
      const value = await store.getSecretById(id);
      expect(value).toBe("secret-val");
    });

    it("returns null for missing ID", async () => {
      const value = await store.getSecretById("019d0000-0000-7000-8000-000000000099");
      expect(value).toBeNull();
    });
  });

  describe("getSecretMeta", () => {
    it("returns metadata without the value", async () => {
      const { id } = await store.putSecret({
        name: "meta_test",
        plaintext: "should-not-appear",
        description: "Test key",
      });
      const meta = await store.getSecretMeta("meta_test");
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
      await store.putSecret({ name: "key_a", plaintext: "a" });
      await store.putSecret({ name: "key_b", plaintext: "b" });
      const list = await store.listSecrets();
      const names = list.map((s) => s.name).sort();
      expect(names).toEqual(["key_a", "key_b"]);
    });

    it("returns empty array when no secrets", async () => {
      const list = await store.listSecrets();
      expect(list).toEqual([]);
    });
  });

  describe("markValidated", () => {
    it("sets validatedAt timestamp", async () => {
      await store.putSecret({ name: "validated", plaintext: "v" });
      const before = await store.getSecretMeta("validated");
      expect(before?.validatedAt).toBeNull();

      await store.markValidated("validated");

      const after = await store.getSecretMeta("validated");
      expect(after?.validatedAt).toBeInstanceOf(Date);
    });
  });

  describe("deleteSecret", () => {
    it("removes a secret by name", async () => {
      await store.putSecret({ name: "to_delete", plaintext: "gone" });
      await store.deleteSecret("to_delete");
      const value = await store.getSecret("to_delete");
      expect(value).toBeNull();
    });
  });

  describe("deleteAllSecrets", () => {
    it("removes all secrets", async () => {
      await store.putSecret({ name: "a", plaintext: "1" });
      await store.putSecret({ name: "b", plaintext: "2" });
      await store.deleteAllSecrets();
      const list = await store.listSecrets();
      expect(list).toEqual([]);
    });
  });
});
