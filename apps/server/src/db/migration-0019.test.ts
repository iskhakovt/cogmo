/**
 * Migration 0019 covers a non-trivial case: when an operator has registered
 * BOTH the deprecated id and its successor against the same provider (or at
 * the same position on the same model), a naive UPDATE would violate either
 * `unique(model, provider_id)` or `unique(model, position)`. The migration
 * resolves this with dedup-then-rename plus a position-bump pre-pass.
 *
 * These tests run the raw migration SQL against PGlite and assert the
 * post-migration state for each conflict shape — so a future regression
 * (someone "simplifies" the SQL and breaks one of the cases) fails CI.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { asc, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { llmProviders, modelProviders, profiles } from "../agent/store/schema.js";
import { secrets } from "../secrets/store/schema.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { Database } from "./index.js";

const MIGRATION_SQL = await readFile(
  fileURLToPath(new URL("../../migrations/0019_replace_deprecated_models.sql", import.meta.url)),
  "utf8",
);

interface ProviderRow {
  id: string;
  name: string;
}

async function seedProviders(db: Database, names: string[]): Promise<ProviderRow[]> {
  const rows: ProviderRow[] = [];
  for (const name of names) {
    const [secret] = await db
      .insert(secrets)
      .values({ name: `${name}_key`, ciphertext: "x", nonce: "x" })
      .returning({ id: secrets.id });
    if (!secret) throw new Error("seed secret failed");
    const [prov] = await db
      .insert(llmProviders)
      .values({ name, type: "anthropic", secretId: secret.id, attrs: {} })
      .returning({ id: llmProviders.id });
    if (!prov) throw new Error("seed provider failed");
    rows.push({ id: prov.id, name });
  }
  return rows;
}

async function insertModelProvider(
  db: Database,
  model: string,
  providerId: string,
  position: number,
): Promise<void> {
  await db.insert(modelProviders).values({ model, providerId, position, userSelectable: true });
}

async function listModelProviders(
  db: Database,
): Promise<Array<{ model: string; providerId: string; position: number }>> {
  return db
    .select({
      model: modelProviders.model,
      providerId: modelProviders.providerId,
      position: modelProviders.position,
    })
    .from(modelProviders)
    .orderBy(asc(modelProviders.model), asc(modelProviders.position));
}

async function applyMigration(db: Database): Promise<void> {
  // Migration uses Drizzle's `--> statement-breakpoint` markers; split on those
  // and run each statement separately so PGlite gets one statement per execute.
  const statements = MIGRATION_SQL.split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
}

describe("migration 0019 — replace deprecated models", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeEach(async () => {
    if (!db) {
      const created = await createTestDatabase();
      db = created.db;
      close = created.close;
    } else {
      await truncateAll(db);
    }
  });

  afterAll(async () => {
    await close?.();
  });

  it("renames model_providers when only the deprecated id is registered", async () => {
    const [provA] = await seedProviders(db, ["A"]);
    if (!provA) throw new Error("seed failed");
    await insertModelProvider(db, "claude-sonnet-4-20250514", provA.id, 0);
    await insertModelProvider(db, "claude-opus-4-20250514", provA.id, 1);

    await applyMigration(db);

    expect(await listModelProviders(db)).toEqual([
      { model: "claude-opus-4-7", providerId: provA.id, position: 1 },
      { model: "claude-sonnet-4-6", providerId: provA.id, position: 0 },
    ]);
  });

  it("drops the deprecated row when the successor is already registered for the same provider", async () => {
    const [provA] = await seedProviders(db, ["A"]);
    if (!provA) throw new Error("seed failed");
    // Operator added the new id alongside the old one: same provider, different positions
    await insertModelProvider(db, "claude-sonnet-4-20250514", provA.id, 0);
    await insertModelProvider(db, "claude-sonnet-4-6", provA.id, 1);

    await applyMigration(db);

    expect(await listModelProviders(db)).toEqual([
      { model: "claude-sonnet-4-6", providerId: provA.id, position: 1 },
    ]);
  });

  it("bumps the deprecated row's position when a different provider already holds that position on the successor", async () => {
    const [provA, provB] = await seedProviders(db, ["A", "B"]);
    if (!provA || !provB) throw new Error("seed failed");
    // Conflict shape: (old, A, 0) and (new, B, 0). Provider-dedup doesn't fire
    // (different providers); without the position-bump, the rename would
    // produce two rows at (claude-sonnet-4-6, position=0) and violate
    // unique(model, position).
    await insertModelProvider(db, "claude-sonnet-4-20250514", provA.id, 0);
    await insertModelProvider(db, "claude-sonnet-4-6", provB.id, 0);

    await applyMigration(db);

    expect(await listModelProviders(db)).toEqual([
      { model: "claude-sonnet-4-6", providerId: provB.id, position: 0 },
      { model: "claude-sonnet-4-6", providerId: provA.id, position: 1 },
    ]);
  });

  it("handles both unique constraints simultaneously (provider-dedup + position-bump)", async () => {
    const [provA, provB, provC] = await seedProviders(db, ["A", "B", "C"]);
    if (!provA || !provB || !provC) throw new Error("seed failed");
    // (old, A, 0) — same-provider conflict with (new, A, 5) → DELETED by dedup
    // (old, B, 1) — position conflict with (new, C, 1) → bumped to position 6
    // (new, A, 5) — kept
    // (new, C, 1) — kept
    await insertModelProvider(db, "claude-sonnet-4-20250514", provA.id, 0);
    await insertModelProvider(db, "claude-sonnet-4-20250514", provB.id, 1);
    await insertModelProvider(db, "claude-sonnet-4-6", provA.id, 5);
    await insertModelProvider(db, "claude-sonnet-4-6", provC.id, 1);

    await applyMigration(db);

    expect(await listModelProviders(db)).toEqual([
      { model: "claude-sonnet-4-6", providerId: provC.id, position: 1 },
      { model: "claude-sonnet-4-6", providerId: provA.id, position: 5 },
      { model: "claude-sonnet-4-6", providerId: provB.id, position: 6 },
    ]);
  });

  it("fans multiple bumped rows out past the highest existing successor position", async () => {
    const [provA, provB, provC, provD] = await seedProviders(db, ["A", "B", "C", "D"]);
    if (!provA || !provB || !provC || !provD) throw new Error("seed failed");
    // Two old rows both conflict on position with two new rows on different
    // providers. After bump: positions must be distinct and greater than the
    // highest existing successor position (which is 1).
    await insertModelProvider(db, "claude-sonnet-4-20250514", provA.id, 0);
    await insertModelProvider(db, "claude-sonnet-4-20250514", provB.id, 1);
    await insertModelProvider(db, "claude-sonnet-4-6", provC.id, 0);
    await insertModelProvider(db, "claude-sonnet-4-6", provD.id, 1);

    await applyMigration(db);

    const rows = await listModelProviders(db);
    expect(rows).toHaveLength(4);
    // The two bumped rows (originally provA, provB) land at positions 2 and 3
    // (in input order — ROW_NUMBER ORDER BY position ASC).
    const bumped = rows.filter((r) => r.providerId === provA.id || r.providerId === provB.id);
    expect(bumped.map((r) => r.position).sort()).toEqual([2, 3]);
    // Originals stay put.
    expect(rows.find((r) => r.providerId === provC.id)?.position).toBe(0);
    expect(rows.find((r) => r.providerId === provD.id)?.position).toBe(1);
  });

  it("rewrites profiles.model and the two optional model columns", async () => {
    await db.insert(profiles).values([
      {
        name: "p1",
        basePrompt: "",
        model: "claude-sonnet-4-20250514",
        summarizationModel: "claude-opus-4-20250514",
        extractionModel: "claude-sonnet-4-20250514",
        toolSet: [],
      },
      {
        name: "p2",
        basePrompt: "",
        model: "claude-opus-4-20250514",
        toolSet: [],
      },
    ]);

    await applyMigration(db);

    const rows = await db
      .select({
        name: profiles.name,
        model: profiles.model,
        summarizationModel: profiles.summarizationModel,
        extractionModel: profiles.extractionModel,
      })
      .from(profiles)
      .orderBy(asc(profiles.name));
    expect(rows).toEqual([
      {
        name: "p1",
        model: "claude-sonnet-4-6",
        summarizationModel: "claude-opus-4-7",
        extractionModel: "claude-sonnet-4-6",
      },
      {
        name: "p2",
        model: "claude-opus-4-7",
        summarizationModel: null,
        extractionModel: null,
      },
    ]);
  });

  it("leaves rows that reference unrelated models untouched", async () => {
    const [provA] = await seedProviders(db, ["A"]);
    if (!provA) throw new Error("seed failed");
    await insertModelProvider(db, "claude-haiku-4-5-20251001", provA.id, 0);
    await db.insert(profiles).values({
      name: "p",
      basePrompt: "",
      model: "claude-haiku-4-5-20251001",
      toolSet: [],
    });

    await applyMigration(db);

    expect(await listModelProviders(db)).toEqual([
      { model: "claude-haiku-4-5-20251001", providerId: provA.id, position: 0 },
    ]);
    const [row] = await db.select({ model: profiles.model }).from(profiles);
    expect(row?.model).toBe("claude-haiku-4-5-20251001");
  });
});
