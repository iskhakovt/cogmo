import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../../secrets/encryption.js";
import { DrizzleSecretsStore } from "../../secrets/store/index.js";
import { expectDefined } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { imageModels, imageProviders, llmProviders } from "./schema.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let secretsStore: DrizzleSecretsStore;

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

async function seedSecret(name = "test-key") {
  return tx((trx) => secretsStore.putSecret(trx, { name, plaintext: "sk-test" }));
}

/**
 * Walk `err.cause` looking for a Postgres-shaped error and return it.
 * Drizzle wraps driver errors in `DrizzleQueryError`; PGlite preserves the
 * original `{ code, constraint, message }` shape on `cause`. Same idea as
 * `findPgErrorByCode` in `./errors.ts`, but local so we can match any code
 * (not just the unique/FK helpers exported there).
 */
function pgErrorCause(err: unknown): {
  code?: string;
  constraint?: string;
  constraint_name?: string;
  message?: string;
} {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur != null; depth++) {
    if (typeof cur === "object" && cur !== null && "code" in cur) {
      return cur as {
        code?: string;
        constraint?: string;
        constraint_name?: string;
        message?: string;
      };
    }
    if (typeof cur === "object" && cur !== null && "cause" in cur) {
      cur = (cur as { cause: unknown }).cause;
      continue;
    }
    break;
  }
  return {};
}

async function expectPgError(
  promise: Promise<unknown>,
  expected: { code: string; constraint?: string },
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  if (caught === undefined) {
    throw new Error(`expected PG error with code ${expected.code}, but promise resolved`);
  }
  const cause = pgErrorCause(caught);
  expect(
    cause.code,
    `expected PG code ${expected.code}, got ${cause.code} (${cause.message})`,
  ).toBe(expected.code);
  if (expected.constraint !== undefined) {
    expect(cause.constraint ?? cause.constraint_name).toBe(expected.constraint);
  }
}

describe("image_providers + image_models schema", () => {
  describe("chk_image_providers_base_url", () => {
    it("accepts fal with NULL base_url", async () => {
      const { id: secretId } = await seedSecret("fal_key");
      await expect(
        tx((trx) =>
          trx
            .insert(imageProviders)
            .values({ name: "fal", type: "fal", baseUrl: null, secretId, attrs: {} }),
        ),
      ).resolves.not.toThrow();
    });

    it("accepts openai_compatible with non-NULL base_url", async () => {
      const { id: secretId } = await seedSecret("venice_key");
      await expect(
        tx((trx) =>
          trx.insert(imageProviders).values({
            name: "venice",
            type: "openai_compatible",
            baseUrl: "https://api.venice.ai/api/v1",
            secretId,
            attrs: {},
          }),
        ),
      ).resolves.not.toThrow();
    });

    it("rejects fal with a base_url (CHECK violation 23514)", async () => {
      const { id: secretId } = await seedSecret("fal_key");
      await expectPgError(
        tx((trx) =>
          trx.insert(imageProviders).values({
            name: "fal",
            type: "fal",
            baseUrl: "https://fal.run",
            secretId,
            attrs: {},
          }),
        ),
        { code: "23514", constraint: "chk_image_providers_base_url" },
      );
    });

    it("rejects openai_compatible with NULL base_url (CHECK violation 23514)", async () => {
      const { id: secretId } = await seedSecret("venice_key");
      await expectPgError(
        tx((trx) =>
          trx.insert(imageProviders).values({
            name: "venice",
            type: "openai_compatible",
            baseUrl: null,
            secretId,
            attrs: {},
          }),
        ),
        { code: "23514", constraint: "chk_image_providers_base_url" },
      );
    });
  });

  describe("image_providers.name unique", () => {
    it("rejects duplicate names (UNIQUE violation 23505)", async () => {
      const { id: secretId } = await seedSecret();
      await tx((trx) =>
        trx
          .insert(imageProviders)
          .values({ name: "fal", type: "fal", baseUrl: null, secretId, attrs: {} }),
      );
      await expectPgError(
        tx((trx) =>
          trx
            .insert(imageProviders)
            .values({ name: "fal", type: "fal", baseUrl: null, secretId, attrs: {} }),
        ),
        { code: "23505", constraint: "image_providers_name_unique" },
      );
    });
  });

  describe("image_models.provider_id ON DELETE CASCADE", () => {
    it("deletes models when their provider is deleted", async () => {
      const { id: secretId } = await seedSecret();
      const inserted = await tx((trx) =>
        trx
          .insert(imageProviders)
          .values({ name: "fal", type: "fal", baseUrl: null, secretId, attrs: {} })
          .returning({ id: imageProviders.id }),
      );
      const { id: providerId } = expectDefined(inserted[0], "inserted provider");
      await tx((trx) =>
        trx.insert(imageModels).values([
          {
            providerId,
            name: "fal/flux-dev",
            modelString: "fal-ai/flux/dev",
            description: "default",
            capabilities: { aspectRatios: ["1:1", "16:9"], seed: true },
            userSelectable: true,
          },
          {
            providerId,
            name: "fal/flux-schnell",
            modelString: "fal-ai/flux/schnell",
            description: "fast",
            capabilities: { aspectRatios: ["1:1"] },
            userSelectable: true,
          },
        ]),
      );

      const before = await tx((trx) => trx.select().from(imageModels));
      expect(before).toHaveLength(2);

      await tx((trx) => trx.delete(imageProviders).where(eq(imageProviders.id, providerId)));

      const after = await tx((trx) => trx.select().from(imageModels));
      expect(after).toHaveLength(0);
    });
  });

  describe("image_models.name unique", () => {
    it("rejects duplicate names across providers", async () => {
      const { id: secretId } = await seedSecret();
      const falRows = await tx((trx) =>
        trx
          .insert(imageProviders)
          .values({ name: "fal", type: "fal", baseUrl: null, secretId, attrs: {} })
          .returning({ id: imageProviders.id }),
      );
      const { id: falId } = expectDefined(falRows[0], "fal provider");
      const veniceRows = await tx((trx) =>
        trx
          .insert(imageProviders)
          .values({
            name: "venice",
            type: "openai_compatible",
            baseUrl: "https://api.venice.ai/api/v1",
            secretId,
            attrs: {},
          })
          .returning({ id: imageProviders.id }),
      );
      const { id: veniceId } = expectDefined(veniceRows[0], "venice provider");
      await tx((trx) =>
        trx.insert(imageModels).values({
          providerId: falId,
          name: "flux-dev",
          modelString: "fal-ai/flux/dev",
          description: "via fal",
          capabilities: {},
          userSelectable: true,
        }),
      );
      // Same `name` against a different provider — still must be globally unique.
      await expectPgError(
        tx((trx) =>
          trx.insert(imageModels).values({
            providerId: veniceId,
            name: "flux-dev",
            modelString: "flux-dev",
            description: "via venice",
            capabilities: {},
            userSelectable: true,
          }),
        ),
        { code: "23505", constraint: "image_models_name_unique" },
      );
    });
  });

  describe("capabilities JSONB roundtrip via Zod", () => {
    it("preserves aspectRatios and seed on read", async () => {
      const { id: secretId } = await seedSecret();
      const inserted = await tx((trx) =>
        trx
          .insert(imageProviders)
          .values({ name: "fal", type: "fal", baseUrl: null, secretId, attrs: {} })
          .returning({ id: imageProviders.id }),
      );
      const { id: providerId } = expectDefined(inserted[0], "inserted provider");
      await tx((trx) =>
        trx.insert(imageModels).values({
          providerId,
          name: "fal/flux-dev",
          modelString: "fal-ai/flux/dev",
          description: "default",
          capabilities: { aspectRatios: ["1:1", "16:9", "21:9"], seed: true },
          userSelectable: true,
        }),
      );
      const [row] = await tx((trx) => trx.select().from(imageModels));
      expect(row?.capabilities).toEqual({ aspectRatios: ["1:1", "16:9", "21:9"], seed: true });
    });
  });
});

describe("llm_providers.type enum (post-migration)", () => {
  it("accepts the enum values", async () => {
    const { id: secretId } = await seedSecret();
    await expect(
      tx((trx) =>
        trx
          .insert(llmProviders)
          .values({ name: "anthropic-direct", type: "anthropic", secretId, attrs: {} }),
      ),
    ).resolves.not.toThrow();
    await expect(
      tx((trx) =>
        trx
          .insert(llmProviders)
          .values({ name: "openrouter", type: "openai_compatible", secretId, attrs: {} }),
      ),
    ).resolves.not.toThrow();
  });

  it("rejects an out-of-enum type via raw SQL (PG code 22P02)", async () => {
    const { id: secretId } = await seedSecret();
    // 22P02 is `invalid_text_representation` — what Postgres throws when an
    // enum cast fails. Sentinel for "the column actually rejects rogue values."
    await expectPgError(
      tx((trx) =>
        trx.execute(
          sql`INSERT INTO llm_providers (name, type, secret_id, attrs) VALUES ('rogue', 'unknown-vendor', ${secretId}, '{}'::jsonb)`,
        ),
      ),
      { code: "22P02" },
    );
  });
});
