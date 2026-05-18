import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../../secrets/encryption.js";
import { DrizzleSecretsStore } from "../../secrets/store/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { imageProviders, llmProviders } from "./schema.js";

/**
 * Schema-level invariants for image_providers + the post-migration
 * llm_providers.type enum. Scope is deliberately narrow:
 *
 * - The DB CHECK on image_providers.base_url is defense-in-depth that the
 *   future store method (which translates inputs to `InvalidProviderConfigError`)
 *   can't reach. One PGlite test pins each accept/reject case.
 * - The llm_providers.type enum cast (`USING type::llm_provider_type` in
 *   migration 0029) is locked in here — store method inserts go via the
 *   narrowed TS literal type and can't exercise the raw-SQL rejection path.
 *
 * UNIQUE name violations, ON DELETE CASCADE, and JSONB roundtrip are
 * covered by the store-method tests that ship with the implementation PR
 * (precedent: `store.test.ts` → "deleteProvider cascades to model_providers",
 * "updateProfile translates unique-name collision to UniqueViolationError"),
 * so they don't get duplicate coverage here.
 */

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
 * (not just the unique/FK helpers exported there — we need 23514 for
 * CHECK and 22P02 for the enum rejection, neither of which has a helper).
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

  it("accepts venice with non-NULL base_url", async () => {
    const { id: secretId } = await seedSecret("venice_native_key");
    await expect(
      tx((trx) =>
        trx.insert(imageProviders).values({
          name: "venice-native",
          type: "venice",
          baseUrl: "https://api.venice.ai/api/v1",
          secretId,
          attrs: {},
        }),
      ),
    ).resolves.not.toThrow();
  });

  it("rejects venice with NULL base_url (CHECK violation 23514)", async () => {
    const { id: secretId } = await seedSecret("venice_native_key");
    await expectPgError(
      tx((trx) =>
        trx.insert(imageProviders).values({
          name: "venice-native",
          type: "venice",
          baseUrl: null,
          secretId,
          attrs: {},
        }),
      ),
      { code: "23514", constraint: "chk_image_providers_base_url" },
    );
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
