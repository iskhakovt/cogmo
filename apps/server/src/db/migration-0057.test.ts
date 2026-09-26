/**
 * Migration 0057 replaces `llm_providers.attrs.promptCaching` with
 * `cacheDialect`, derived from each OpenAI-compatible row's base-URL host.
 * Runs the raw migration SQL against PGlite over rows seeded in the
 * pre-migration shape (raw SQL, since the store schema no longer writes it)
 * and asserts the rewritten JSONB, then that the store reads it.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { asc, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { llmProviders } from "../agent/store/schema.js";
import { secrets } from "../secrets/store/schema.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { Database } from "./index.js";

const MIGRATION_SQL = await readFile(
  fileURLToPath(new URL("../../migrations/0057_cache_dialect.sql", import.meta.url)),
  "utf8",
);

interface LegacyRow {
  name: string;
  type: "anthropic" | "openai_compatible";
  baseUrl: string | null;
  attrs: Record<string, unknown>;
}

const RawAttrsSchema = z.object({
  rows: z.array(z.object({ name: z.string(), attrs: z.record(z.string(), z.unknown()) })),
});

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

async function seed(rows: ReadonlyArray<LegacyRow>): Promise<void> {
  for (const row of rows) {
    const [secret] = await db
      .insert(secrets)
      .values({ name: `${row.name}_api_key`, ciphertext: "x", nonce: "x" })
      .returning({ id: secrets.id });
    const secretId = expectDefined(secret, "seeded secret").id;
    await db.execute(sql`
      INSERT INTO llm_providers (name, type, base_url, secret_id, attrs)
      VALUES (${row.name}, ${row.type}, ${row.baseUrl}, ${secretId}, ${JSON.stringify(row.attrs)}::jsonb)
    `);
  }
}

async function applyMigration(): Promise<void> {
  const statements = MIGRATION_SQL.split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
}

async function rawAttrs(): Promise<Record<string, Record<string, unknown>>> {
  const result = RawAttrsSchema.parse(
    await db.execute(sql`SELECT name, attrs FROM llm_providers ORDER BY name`),
  );
  return Object.fromEntries(result.rows.map((r) => [r.name, r.attrs]));
}

function compat(name: string, baseUrl: string | null, attrs: Record<string, unknown>): LegacyRow {
  return { name, type: "openai_compatible", baseUrl, attrs };
}

describe("migration 0057 — cache dialect", () => {
  it("derives each OpenAI-compatible row's dialect from its base-URL host", async () => {
    await seed([
      compat("openrouter", "https://openrouter.ai/api/v1", { promptCaching: true }),
      compat("openrouter-off", "https://openrouter.ai/api/v1", { promptCaching: false }),
      compat("openai", "https://api.openai.com/v1", {}),
      compat("xai", "https://api.x.ai/v1", {}),
      compat("xai-upper", "HTTPS://API.X.AI/v1", {}),
      compat("xai-port-userinfo", "https://user:pw@api.x.ai:443/v1", {}),
      compat("deepseek", "https://api.deepseek.com/v1", { promptCaching: true }),
      compat("lookalike", "https://openrouter.ai.evil.test/v1", {}),
      compat("local", "http://localhost:8000/v1", {}),
      compat("no-url", null, {}),
    ]);

    await applyMigration();

    expect(await rawAttrs()).toEqual({
      openrouter: { cacheDialect: "openrouter" },
      "openrouter-off": { cacheDialect: "openrouter" },
      openai: { cacheDialect: "openai" },
      xai: { cacheDialect: "xai" },
      "xai-upper": { cacheDialect: "xai" },
      "xai-port-userinfo": { cacheDialect: "xai" },
      deepseek: { cacheDialect: "none" },
      lookalike: { cacheDialect: "none" },
      local: { cacheDialect: "none" },
      "no-url": { cacheDialect: "none" },
    });
  });

  it("drops the old key from Anthropic rows without giving them a dialect", async () => {
    await seed([
      { name: "anthropic", type: "anthropic", baseUrl: null, attrs: { promptCaching: true } },
      { name: "anthropic-plain", type: "anthropic", baseUrl: null, attrs: {} },
    ]);

    await applyMigration();

    expect(await rawAttrs()).toEqual({ anthropic: {}, "anthropic-plain": {} });
  });

  it("keeps the other attrs", async () => {
    await seed([
      compat("openrouter", "https://openrouter.ai/api/v1", {
        promptCaching: true,
        headers: { "HTTP-Referer": "https://cogmo.test" },
      }),
      {
        name: "anthropic",
        type: "anthropic",
        baseUrl: null,
        attrs: { headers: { "x-test": "1" } },
      },
    ]);

    await applyMigration();

    expect(await rawAttrs()).toEqual({
      openrouter: { cacheDialect: "openrouter", headers: { "HTTP-Referer": "https://cogmo.test" } },
      anthropic: { headers: { "x-test": "1" } },
    });
  });

  it("leaves rows the store reads back with their dialect", async () => {
    await seed([
      compat("openrouter", "https://openrouter.ai/api/v1", { promptCaching: true }),
      { name: "anthropic", type: "anthropic", baseUrl: null, attrs: { promptCaching: true } },
    ]);

    await applyMigration();

    const rows = await db
      .select({ name: llmProviders.name, attrs: llmProviders.attrs })
      .from(llmProviders)
      .orderBy(asc(llmProviders.name));
    expect(rows).toEqual([
      { name: "anthropic", attrs: {} },
      { name: "openrouter", attrs: { cacheDialect: "openrouter" } },
    ]);
  });
});
