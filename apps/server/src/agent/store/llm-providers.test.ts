import { sql } from "drizzle-orm";
import * as R from "remeda";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import type { CacheDialect } from "../../llm/cache-dialect.js";
import type { ExtraBody } from "../../llm/extra-body.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../../secrets/encryption.js";
import { DrizzleSecretsStore } from "../../secrets/store/index.js";
import { expectDefined } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleLlmProviderStore } from "./llm-providers.js";
import type { ProviderAttrs } from "./schema.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let secretsStore: DrizzleSecretsStore;
const store = new DrizzleLlmProviderStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  const key = deriveMasterKey(parseMasterKey(generateMasterKey()), "cogmo/secrets-at-rest/v1");
  secretsStore = new DrizzleSecretsStore(key);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

describe("DrizzleLlmProviderStore", () => {
  describe("providers", () => {
    async function seedProvider(name = "test-provider") {
      const { id: secretId } = await tx((trx) =>
        secretsStore.putSecret(trx, {
          name: `${name}_key`,
          plaintext: "sk-test",
        }),
      );
      return tx((trx) =>
        store.createProvider(trx, {
          name,
          type: "anthropic",
          secretId,
          attrs: {},
        }),
      );
    }

    it("creates and retrieves a provider", async () => {
      const { id } = await seedProvider();
      const provider = await tx((trx) => store.getProvider(trx, id));
      expect(provider).toMatchObject({ name: "test-provider", type: "anthropic" });
    });

    it("lists providers", async () => {
      await seedProvider("p1");
      await seedProvider("p2");
      const list = await tx((trx) => store.listProviders(trx));
      expect(list.map((p) => p.name).sort()).toEqual(["p1", "p2"]);
    });

    async function seedGateway(attrs: ProviderAttrs) {
      const { id: secretId } = await tx((trx) =>
        secretsStore.putSecret(trx, { name: "gateway_key", plaintext: "sk-test" }),
      );
      return tx((trx) =>
        store.createProvider(trx, {
          name: "gateway",
          type: "openai_compatible",
          baseUrl: "https://gateway.internal/v1",
          secretId,
          attrs,
        }),
      );
    }

    it("lists each provider's base URL and attrs", async () => {
      await seedProvider("claude");
      await seedGateway({ cacheDialect: "openrouter" });

      const list = await tx((trx) => store.listProviders(trx));

      expect(R.sortBy(list, (p) => p.name)).toEqual([
        expect.objectContaining({ name: "claude", type: "anthropic", baseUrl: null, attrs: {} }),
        expect.objectContaining({
          name: "gateway",
          type: "openai_compatible",
          baseUrl: "https://gateway.internal/v1",
          attrs: { cacheDialect: "openrouter" },
        }),
      ]);
    });

    describe("setProviderCacheDialect", () => {
      it("sets the dialect and keeps the provider's other attrs", async () => {
        const { id } = await seedGateway({
          cacheDialect: "openrouter",
          headers: { "HTTP-Referer": "https://cogmo.example" },
        });

        const updated = await tx((trx) => store.setProviderCacheDialect(trx, id, "none"));

        expect(updated).toBe(true);
        const provider = await tx((trx) => store.getProvider(trx, id));
        expect(provider?.attrs).toEqual({
          cacheDialect: "none",
          headers: { "HTTP-Referer": "https://cogmo.example" },
        });
      });

      it("adds a dialect to a row that has none", async () => {
        const { id } = await seedGateway({});

        await tx((trx) => store.setProviderCacheDialect(trx, id, "openai"));

        const provider = await tx((trx) => store.getProvider(trx, id));
        expect(provider?.attrs).toEqual({ cacheDialect: "openai" });
      });

      it("leaves other providers alone", async () => {
        const { id } = await seedGateway({ cacheDialect: "openrouter" });
        const { id: otherId } = await seedProvider("claude");

        await tx((trx) => store.setProviderCacheDialect(trx, id, "none"));

        const other = await tx((trx) => store.getProvider(trx, otherId));
        expect(other?.attrs).toEqual({});
      });

      it("returns false when no provider has the id", async () => {
        const updated = await tx((trx) =>
          store.setProviderCacheDialect(trx, "01900000-0000-7000-8000-000000000000", "none"),
        );

        expect(updated).toBe(false);
      });

      it("rejects a dialect outside the schema", async () => {
        const { id } = await seedGateway({ cacheDialect: "openrouter" });

        await expect(
          tx((trx) => store.setProviderCacheDialect(trx, id, "bogus" as unknown as CacheDialect)),
        ).rejects.toThrow();
        const provider = await tx((trx) => store.getProvider(trx, id));
        expect(provider?.attrs).toEqual({ cacheDialect: "openrouter" });
      });
    });

    it("deleteProvider cascades to model_providers", async () => {
      const { id: providerId } = await seedProvider();
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "claude-test",
          providerId,
          position: 0,
          userSelectable: true,
        }),
      );

      await tx((trx) => store.deleteProvider(trx, providerId));

      expect(await tx((trx) => store.getProvider(trx, providerId))).toBeUndefined();
      expect(await tx((trx) => store.listProvidersForModel(trx, "claude-test"))).toEqual([]);
    });
  });

  describe("model_providers", () => {
    async function seedProviderWithSecret(name: string) {
      const { id: secretId } = await tx((trx) =>
        secretsStore.putSecret(trx, {
          name: `${name}_key`,
          plaintext: "sk-test",
        }),
      );
      return tx((trx) =>
        store.createProvider(trx, { name, type: "anthropic", secretId, attrs: {} }),
      );
    }

    describe("extra body", () => {
      async function seedRow(extraBody?: ExtraBody | null) {
        const { id: providerId } = await seedProviderWithSecret("custom");
        await tx((trx) =>
          store.addModelProvider(trx, {
            model: "qwen-3-6-plus",
            providerId,
            position: 0,
            userSelectable: true,
            ...(extraBody !== undefined && { extraBody }),
          }),
        );
        return providerId;
      }

      async function stored(): Promise<ExtraBody | null> {
        const rows = await tx((trx) => store.listProvidersForModel(trx, "qwen-3-6-plus"));
        return expectDefined(rows[0], "routing row").extraBody;
      }

      it("reads back as null when the row is added without one", async () => {
        await seedRow();

        expect(await stored()).toBeNull();
      });

      it("round-trips through add, both lists, set and clear", async () => {
        const providerId = await seedRow({
          venice_parameters: { disable_thinking: true, strip_thinking_response: false },
        });

        expect(await stored()).toEqual({
          venice_parameters: { disable_thinking: true, strip_thinking_response: false },
        });
        const all = await tx((trx) => store.listAllModelProviders(trx));
        expect(all.map((row) => row.extraBody)).toEqual([
          { venice_parameters: { disable_thinking: true, strip_thinking_response: false } },
        ]);

        const set = await tx((trx) =>
          store.setModelProviderExtraBody(trx, "qwen-3-6-plus", providerId, {
            reasoning: { enabled: false },
          }),
        );
        expect(set).toBe(true);
        expect(await stored()).toEqual({ reasoning: { enabled: false } });

        const cleared = await tx((trx) =>
          store.setModelProviderExtraBody(trx, "qwen-3-6-plus", providerId, null),
        );
        expect(cleared).toBe(true);
        expect(await stored()).toBeNull();
      });

      it("changes only the (model, provider) row it names", async () => {
        const providerId = await seedRow();
        await tx((trx) =>
          store.addModelProvider(trx, {
            model: "other-model",
            providerId,
            position: 0,
            userSelectable: true,
          }),
        );

        await tx((trx) =>
          store.setModelProviderExtraBody(trx, "other-model", providerId, { top_p: 0.5 }),
        );

        expect(await stored()).toBeNull();
      });

      it("returns false when no row matches", async () => {
        const providerId = await seedRow();

        const updated = await tx((trx) =>
          store.setModelProviderExtraBody(trx, "missing-model", providerId, { top_p: 0.5 }),
        );

        expect(updated).toBe(false);
      });

      it("refuses a reserved key on write and keeps the stored value", async () => {
        const providerId = await seedRow({ reasoning: { enabled: false } });

        await expect(
          tx((trx) =>
            store.setModelProviderExtraBody(trx, "qwen-3-6-plus", providerId, {
              stream: false,
            } as unknown as ExtraBody),
          ),
        ).rejects.toThrow(/stream\\" is set by the adapter/);
        expect(await stored()).toEqual({ reasoning: { enabled: false } });
      });

      it("refuses a reserved key on add", async () => {
        const { id: providerId } = await seedProviderWithSecret("custom");

        await expect(
          tx((trx) =>
            store.addModelProvider(trx, {
              model: "qwen-3-6-plus",
              providerId,
              position: 0,
              userSelectable: true,
              extraBody: { max_tokens: 10 } as unknown as ExtraBody,
            }),
          ),
        ).rejects.toThrow(/max_tokens\\" is set by the adapter/);
        expect(await tx((trx) => store.listProvidersForModel(trx, "qwen-3-6-plus"))).toEqual([]);
      });

      it("reads past a reserved key written outside the store, dropping it", async () => {
        const providerId = await seedRow();
        await db.execute(
          sql`UPDATE model_providers SET extra_body = '{"model":"other","top_p":0.5}'::jsonb WHERE provider_id = ${providerId}`,
        );

        expect(await stored()).toEqual({ top_p: 0.5 });
        const all = await tx((trx) => store.listAllModelProviders(trx));
        expect(all.map((row) => row.extraBody)).toEqual([{ top_p: 0.5 }]);
      });

      it("reads a row left with only reserved keys as having none", async () => {
        const providerId = await seedRow();
        await db.execute(
          sql`UPDATE model_providers SET extra_body = '{"model":"other"}'::jsonb WHERE provider_id = ${providerId}`,
        );

        expect(await stored()).toBeNull();
        const all = await tx((trx) => store.listAllModelProviders(trx));
        expect(all.map((row) => row.extraBody)).toEqual([null]);
      });
    });

    it("resolves the lowest-position provider for a model", async () => {
      const { id: fallbackId } = await seedProviderWithSecret("fallback");
      const { id: primaryId } = await seedProviderWithSecret("primary");

      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "claude-sonnet-4",
          providerId: fallbackId,
          position: 1,
          userSelectable: true,
        }),
      );
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "claude-sonnet-4",
          providerId: primaryId,
          position: 0,
          userSelectable: true,
        }),
      );

      const rows = await tx((trx) => store.listProvidersForModel(trx, "claude-sonnet-4"));
      expect(rows[0]?.name).toBe("primary");
    });

    it("returns an empty list when no provider is registered for a model", async () => {
      const rows = await tx((trx) => store.listProvidersForModel(trx, "nonexistent-model"));
      expect(rows).toEqual([]);
    });

    it("removes model_providers by provider", async () => {
      const { id: providerId } = await seedProviderWithSecret("removable");
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "model-a",
          providerId,
          position: 0,
          userSelectable: true,
        }),
      );
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "model-b",
          providerId,
          position: 0,
          userSelectable: true,
        }),
      );

      await tx((trx) => store.removeModelProvidersByProvider(trx, providerId));

      expect(await tx((trx) => store.listProvidersForModel(trx, "model-a"))).toEqual([]);
      expect(await tx((trx) => store.listProvidersForModel(trx, "model-b"))).toEqual([]);
    });

    it("enforces unique (model, position)", async () => {
      const { id: p1 } = await seedProviderWithSecret("p1");
      const { id: p2 } = await seedProviderWithSecret("p2");

      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "claude-test",
          providerId: p1,
          position: 0,
          userSelectable: true,
        }),
      );

      await expect(
        tx((trx) =>
          store.addModelProvider(trx, {
            model: "claude-test",
            providerId: p2,
            position: 0,
            userSelectable: true,
          }),
        ),
      ).rejects.toThrow();
    });

    it("listProvidersForModel returns all providers in position ASC order", async () => {
      const { id: pZero } = await seedProviderWithSecret("pri");
      const { id: pOne } = await seedProviderWithSecret("sec");
      const { id: pTwo } = await seedProviderWithSecret("ter");

      // Insert out-of-order to verify sort isn't insertion-order-dependent.
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "claude-x",
          providerId: pZero,
          position: 0,
          userSelectable: true,
        }),
      );
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "claude-x",
          providerId: pTwo,
          position: 2,
          userSelectable: true,
        }),
      );
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "claude-x",
          providerId: pOne,
          position: 1,
          userSelectable: true,
        }),
      );

      const list = await tx((trx) => store.listProvidersForModel(trx, "claude-x"));
      expect(list.map((p) => p.name)).toEqual(["pri", "sec", "ter"]);
    });

    it("listProvidersForModel returns empty array when model has no providers", async () => {
      expect(await tx((trx) => store.listProvidersForModel(trx, "unknown-model"))).toEqual([]);
    });

    it("listDistinctUserSelectableModels excludes internal-only models", async () => {
      const { id: p } = await seedProviderWithSecret("p");
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "model-public",
          providerId: p,
          position: 0,
          userSelectable: true,
        }),
      );
      await tx((trx) =>
        store.addModelProvider(trx, {
          model: "model-internal",
          providerId: p,
          position: 1,
          userSelectable: false,
        }),
      );

      expect(await tx((trx) => store.listDistinctUserSelectableModels(trx))).toEqual([
        "model-public",
      ]);
      expect(await tx((trx) => store.isModelUserSelectable(trx, "model-public"))).toBe(true);
      expect(await tx((trx) => store.isModelUserSelectable(trx, "model-internal"))).toBe(false);
      expect(await tx((trx) => store.isModelUserSelectable(trx, "model-missing"))).toBe(false);
    });
  });
});
