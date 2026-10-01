import { err } from "neverthrow";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../../secrets/encryption.js";
import { DrizzleSecretsStore } from "../../secrets/store/index.js";
import { expectOk } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleImageProviderStore } from "./image-providers.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let secretsStore: DrizzleSecretsStore;
const store = new DrizzleImageProviderStore();

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

describe("DrizzleImageProviderStore", () => {
  describe("image providers", () => {
    async function seedSecret(name: string) {
      return tx((trx) => secretsStore.putSecret(trx, { name, plaintext: "sk-test" }));
    }

    it("creates a fal provider (base_url null)", async () => {
      const { id: secretId } = await seedSecret("fal_api_key");
      const { id } = await tx((trx) =>
        store
          .createImageProvider(trx, {
            name: "fal",
            type: "fal",
            baseUrl: null,
            secretId,
            attrs: {},
          })
          .then(expectOk),
      );
      const row = await tx((trx) => store.getImageProvider(trx, id));
      expect(row).toMatchObject({ name: "fal", type: "fal", baseUrl: null });
    });

    it("creates an openai_compatible provider with base_url", async () => {
      const { id: secretId } = await seedSecret("venice_api_key");
      const { id } = await tx((trx) =>
        store
          .createImageProvider(trx, {
            name: "venice",
            type: "openai_compatible",
            baseUrl: "https://api.venice.ai/api/v1",
            secretId,
            attrs: {},
          })
          .then(expectOk),
      );
      const row = await tx((trx) => store.findImageProviderByName(trx, "venice"));
      expect(row).toMatchObject({
        id,
        name: "venice",
        type: "openai_compatible",
        baseUrl: "https://api.venice.ai/api/v1",
      });
    });

    it("rejects fal with a base_url at the store boundary", async () => {
      const { id: secretId } = await seedSecret("fal_api_key");
      const result = await tx((trx) =>
        store.createImageProvider(trx, {
          name: "fal",
          type: "fal",
          baseUrl: "https://fal.run",
          secretId,
          attrs: {},
        }),
      );
      expect(result).toEqual(
        err({ kind: "invalid_provider_config", reason: "fal does not accept a base_url" }),
      );
    });

    it("rejects openai_compatible without base_url at the store boundary", async () => {
      const { id: secretId } = await seedSecret("venice_api_key");
      const result = await tx((trx) =>
        store.createImageProvider(trx, {
          name: "venice",
          type: "openai_compatible",
          baseUrl: null,
          secretId,
          attrs: {},
        }),
      );
      expect(result).toEqual(
        err({ kind: "invalid_provider_config", reason: "openai_compatible requires a base_url" }),
      );
    });

    it("creates a venice provider with base_url + imageGenerationDefaults", async () => {
      const { id: secretId } = await seedSecret("venice_native_api_key");
      const { id } = await tx((trx) =>
        store
          .createImageProvider(trx, {
            name: "venice-native",
            type: "venice",
            baseUrl: "https://api.venice.ai/api/v1",
            secretId,
            attrs: { imageGenerationDefaults: { safe_mode: false, cfg_scale: 7.5 } },
          })
          .then(expectOk),
      );
      const row = await tx((trx) => store.getImageProvider(trx, id));
      expect(row).toMatchObject({
        name: "venice-native",
        type: "venice",
        baseUrl: "https://api.venice.ai/api/v1",
        attrs: { imageGenerationDefaults: { safe_mode: false, cfg_scale: 7.5 } },
      });
    });

    it("round-trips all four imageGenerationDefaults fields through the JSONB Zod codec", async () => {
      // The JSONB column runs Zod parse on both write and read. Cover all
      // four optional fields together so a typo in the schema or codec
      // (`hide_watermark`/`style_preset` arrived later than `safe_mode`/
      // `cfg_scale` and have less coverage) surfaces here.
      const { id: secretId } = await seedSecret("venice_all_attrs_api_key");
      const defaults = {
        safe_mode: false,
        cfg_scale: 10.5,
        hide_watermark: true,
        style_preset: "Photographic",
      };
      const { id } = await tx((trx) =>
        store
          .createImageProvider(trx, {
            name: "venice-all",
            type: "venice",
            baseUrl: "https://api.venice.ai/api/v1",
            secretId,
            attrs: { imageGenerationDefaults: defaults },
          })
          .then(expectOk),
      );
      const row = await tx((trx) => store.getImageProvider(trx, id));
      expect(row?.attrs.imageGenerationDefaults).toEqual(defaults);
    });

    it("rejects venice without base_url at the store boundary", async () => {
      const { id: secretId } = await seedSecret("venice_native_api_key");
      const result = await tx((trx) =>
        store.createImageProvider(trx, {
          name: "venice-native",
          type: "venice",
          baseUrl: null,
          secretId,
          attrs: {},
        }),
      );
      expect(result).toEqual(
        err({ kind: "invalid_provider_config", reason: "venice requires a base_url" }),
      );
    });

    it("rejects non-https base_url", async () => {
      const { id: secretId } = await seedSecret("rogue_api_key");
      const result = await tx((trx) =>
        store.createImageProvider(trx, {
          name: "rogue",
          type: "openai_compatible",
          baseUrl: "http://insecure.example.com/v1",
          secretId,
          attrs: {},
        }),
      );
      expect(result).toEqual(
        err({ kind: "invalid_provider_config", reason: "base_url must be https (got http:)" }),
      );
    });

    it("rejects trailing-slash base_url", async () => {
      const { id: secretId } = await seedSecret("rogue_api_key");
      const result = await tx((trx) =>
        store.createImageProvider(trx, {
          name: "rogue",
          type: "openai_compatible",
          baseUrl: "https://api.venice.ai/api/v1/",
          secretId,
          attrs: {},
        }),
      );
      expect(result).toEqual(
        err({
          kind: "invalid_provider_config",
          reason: "base_url must not end with a trailing slash",
        }),
      );
    });

    it("rejects duplicate provider names", async () => {
      const { id: secretId } = await seedSecret("fal_api_key");
      await tx((trx) =>
        store
          .createImageProvider(trx, {
            name: "fal",
            type: "fal",
            baseUrl: null,
            secretId,
            attrs: {},
          })
          .then(expectOk),
      );
      const result = await tx((trx) =>
        store.createImageProvider(trx, {
          name: "fal",
          type: "fal",
          baseUrl: null,
          secretId,
          attrs: {},
        }),
      );
      expect(result).toEqual(err({ kind: "image_provider_name_taken", name: "fal" }));
    });

    it("lists providers ordered by name", async () => {
      const { id: s1 } = await seedSecret("fal_api_key");
      const { id: s2 } = await seedSecret("venice_api_key");
      await tx((trx) =>
        store
          .createImageProvider(trx, {
            name: "venice",
            type: "openai_compatible",
            baseUrl: "https://api.venice.ai/api/v1",
            secretId: s2,
            attrs: {},
          })
          .then(expectOk),
      );
      await tx((trx) =>
        store
          .createImageProvider(trx, {
            name: "fal",
            type: "fal",
            baseUrl: null,
            secretId: s1,
            attrs: {},
          })
          .then(expectOk),
      );
      const rows = await tx((trx) => store.listImageProviders(trx));
      expect(rows.map((r) => r.name)).toEqual(["fal", "venice"]);
    });

    it("deleteImageProvider cascades to image_models", async () => {
      const { id: secretId } = await seedSecret("fal_api_key");
      const { id: providerId } = await tx((trx) =>
        store
          .createImageProvider(trx, {
            name: "fal",
            type: "fal",
            baseUrl: null,
            secretId,
            attrs: {},
          })
          .then(expectOk),
      );
      await tx((trx) =>
        store
          .createImageModel(trx, {
            providerId,
            name: "fal/flux-dev",
            modelString: "fal-ai/flux/dev",
            description: "default",
            capabilities: { aspectRatios: ["1:1"], seed: true },
            userSelectable: true,
          })
          .then(expectOk),
      );

      await tx((trx) => store.deleteImageProvider(trx, providerId));

      expect(await tx((trx) => store.getImageProvider(trx, providerId))).toBeUndefined();
      expect(await tx((trx) => store.listImageModels(trx))).toEqual([]);
    });
  });

  describe("image models", () => {
    async function seedProvider(name = "fal") {
      const { id: secretId } = await tx((trx) =>
        secretsStore.putSecret(trx, { name: `${name}_api_key`, plaintext: "sk-test" }),
      );
      return tx((trx) =>
        store
          .createImageProvider(trx, {
            name,
            type: "fal",
            baseUrl: null,
            secretId,
            attrs: {},
          })
          .then(expectOk),
      );
    }

    it("creates and lists image models", async () => {
      const { id: providerId } = await seedProvider();
      await tx((trx) =>
        store
          .createImageModel(trx, {
            providerId,
            name: "fal/flux-dev",
            modelString: "fal-ai/flux/dev",
            description: "default",
            capabilities: { aspectRatios: ["1:1", "16:9"], seed: true },
            userSelectable: true,
          })
          .then(expectOk),
      );
      const rows = await tx((trx) => store.listImageModels(trx));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: "fal/flux-dev",
        modelString: "fal-ai/flux/dev",
        capabilities: { aspectRatios: ["1:1", "16:9"], seed: true },
      });
    });

    it("rejects duplicate model names", async () => {
      const { id: providerId } = await seedProvider();
      await tx((trx) =>
        store
          .createImageModel(trx, {
            providerId,
            name: "fal/flux-dev",
            modelString: "fal-ai/flux/dev",
            description: "default",
            capabilities: {},
            userSelectable: true,
          })
          .then(expectOk),
      );
      const result = await tx((trx) =>
        store.createImageModel(trx, {
          providerId,
          name: "fal/flux-dev",
          modelString: "fal-ai/flux/dev",
          description: "duplicate",
          capabilities: {},
          userSelectable: true,
        }),
      );
      expect(result).toEqual(err({ kind: "image_model_name_taken", name: "fal/flux-dev" }));
    });

    it("createImageModel rejects a slug collision with a distinct existing name", async () => {
      // Two distinct full names (`fal-ai/flux-pro` and `replicate/flux-pro`)
      // both reduce to slug `flux-pro` — the LLM-facing identifier. Catch
      // at the insert boundary instead of at next-boot createImageTools.
      const { id: providerId } = await seedProvider();
      await tx((trx) =>
        store
          .createImageModel(trx, {
            providerId,
            name: "fal-ai/flux-pro",
            modelString: "fal-ai/flux-pro",
            description: "first",
            capabilities: {},
            userSelectable: true,
          })
          .then(expectOk),
      );
      const result = await tx((trx) =>
        store.createImageModel(trx, {
          providerId,
          name: "replicate/flux-pro",
          modelString: "replicate/flux-pro",
          description: "second",
          capabilities: {},
          userSelectable: true,
        }),
      );
      expect(result).toEqual(
        err({
          kind: "image_model_slug_collision",
          name: "replicate/flux-pro",
          existingName: "fal-ai/flux-pro",
          slug: "flux-pro",
        }),
      );
    });

    it("upsertImageModelsByName rejects a slug collision in the batch", async () => {
      const { id: providerId } = await seedProvider();
      const result = await tx((trx) =>
        store.upsertImageModelsByName(trx, [
          {
            providerId,
            name: "fal-ai/flux-pro",
            modelString: "fal-ai/flux-pro",
            description: "first",
            capabilities: {},
            userSelectable: true,
          },
          {
            providerId,
            name: "replicate/flux-pro",
            modelString: "replicate/flux-pro",
            description: "second",
            capabilities: {},
            userSelectable: true,
          },
        ]),
      );
      expect(result).toEqual(
        err({
          kind: "image_model_slug_collision",
          name: "replicate/flux-pro",
          existingName: "fal-ai/flux-pro",
          slug: "flux-pro",
        }),
      );
    });

    it("upsertImageModelsByName skips existing names (idempotent)", async () => {
      const { id: providerId } = await seedProvider();
      const rows = [
        {
          providerId,
          name: "fal/a",
          modelString: "fal-ai/a",
          description: "first",
          capabilities: {},
          userSelectable: true,
        },
        {
          providerId,
          name: "fal/b",
          modelString: "fal-ai/b",
          description: "second",
          capabilities: {},
          userSelectable: true,
        },
      ];
      const first = await tx((trx) => store.upsertImageModelsByName(trx, rows).then(expectOk));
      expect(first).toBe(2);

      // Re-run with the same names plus a new one. Existing rows are
      // preserved (no overwrite of `description`); only the new row is
      // inserted.
      const second = await tx((trx) =>
        store
          .upsertImageModelsByName(trx, [
            {
              providerId,
              name: "fal/a",
              modelString: "fal-ai/a",
              description: "edited", // would-be edit; must be ignored
              capabilities: {},
              userSelectable: true,
            },
            {
              providerId,
              name: "fal/c",
              modelString: "fal-ai/c",
              description: "third",
              capabilities: {},
              userSelectable: true,
            },
          ])
          .then(expectOk),
      );
      expect(second).toBe(1);

      const all = await tx((trx) => store.listImageModels(trx));
      expect(all.map((m) => m.name).sort()).toEqual(["fal/a", "fal/b", "fal/c"]);
      const a = all.find((m) => m.name === "fal/a");
      expect(a?.description).toBe("first"); // preserved across the conflict-skip path
    });

    it("listImageModelsWithProvider filters to user_selectable when asked", async () => {
      const { id: providerId } = await seedProvider();
      await tx((trx) =>
        store
          .upsertImageModelsByName(trx, [
            {
              providerId,
              name: "fal/visible",
              modelString: "fal-ai/x",
              description: "shown",
              capabilities: {},
              userSelectable: true,
            },
            {
              providerId,
              name: "fal/hidden",
              modelString: "fal-ai/y",
              description: "hidden",
              capabilities: {},
              userSelectable: false,
            },
          ])
          .then(expectOk),
      );
      const all = await tx((trx) => store.listImageModelsWithProvider(trx));
      const onlySelectable = await tx((trx) =>
        store.listImageModelsWithProvider(trx, { userSelectableOnly: true }),
      );
      expect(all.map((m) => m.name).sort()).toEqual(["fal/hidden", "fal/visible"]);
      expect(onlySelectable.map((m) => m.name)).toEqual(["fal/visible"]);
      expect(onlySelectable[0]?.provider.name).toBe("fal");
    });

    it("deleteImageModel removes a single row without touching siblings", async () => {
      const { id: providerId } = await seedProvider();
      await tx((trx) =>
        store
          .upsertImageModelsByName(trx, [
            {
              providerId,
              name: "fal/keep",
              modelString: "x",
              description: "keep",
              capabilities: {},
              userSelectable: true,
            },
            {
              providerId,
              name: "fal/drop",
              modelString: "y",
              description: "drop",
              capabilities: {},
              userSelectable: true,
            },
          ])
          .then(expectOk),
      );
      const allBefore = await tx((trx) => store.listImageModels(trx));
      const drop = allBefore.find((m) => m.name === "fal/drop");
      expect(drop).toBeDefined();
      await tx((trx) => store.deleteImageModel(trx, drop!.id));
      const after = await tx((trx) => store.listImageModels(trx));
      expect(after.map((m) => m.name)).toEqual(["fal/keep"]);
    });
  });
});
