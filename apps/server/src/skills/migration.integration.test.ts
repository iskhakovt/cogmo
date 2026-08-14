/// <reference path="../../test/vitest.d.ts" />

/**
 * Verifies migration `0017_tough_bedlam.sql` actually creates the expected
 * tables / enums / FKs / indexes against real Postgres. The integration setup
 * applies the migration via `tsx src/main.ts seed`; this test introspects
 * the resulting schema to catch drift between the Drizzle schema definition
 * and the on-disk migration SQL.
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("databaseUrl"), { max: 2 });
});

afterAll(async () => {
  await sql.end();
});

describe("migration 0017_tough_bedlam (skills foundation)", () => {
  it.each(["skills", "skill_deploys", "skill_runs", "skill_context_calls"])(
    "table %s exists",
    async (table) => {
      const rows = await sql<{ to_regclass: string | null }[]>`
      SELECT to_regclass(${table})::text AS to_regclass
    `;
      expect(rows[0]?.to_regclass).toBe(table);
    },
  );

  it.each([
    ["skill_tier", ["wasm", "container"]],
    ["skill_risk_tier", ["auto", "notify", "approve"]],
    ["skill_run_status", ["running", "success", "error"]],
    ["skill_run_trigger", ["manual", "cron", "event"]],
    ["skill_deploy_status", ["pending_approval", "approved", "denied", "live", "rolled_back"]],
  ] as const)("enum %s has expected values", async (typeName, expected) => {
    const rows = await sql<{ enumlabel: string }[]>`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = ${typeName}
      ORDER BY e.enumsortorder
    `;
    expect(rows.map((r) => r.enumlabel)).toEqual([...expected]);
  });

  it("skills.name has an exact-column UNIQUE constraint", async () => {
    // Verify a UNIQUE constraint that targets exactly the `name` column —
    // not a multi-column UNIQUE that happens to include `name`.
    const rows = await sql<{ constraint_name: string }[]>`
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
        AND tc.table_name = ccu.table_name
      WHERE tc.table_name = 'skills'
        AND tc.constraint_type = 'UNIQUE'
        AND ccu.column_name = 'name'
        AND (
          SELECT count(*) FROM information_schema.constraint_column_usage
          WHERE constraint_name = tc.constraint_name AND table_name = tc.table_name
        ) = 1
    `;
    expect(rows.length).toBe(1);
  });

  it.each([
    ["skill_deploys", "skill_id", "skills", "id"],
    ["skill_runs", "skill_id", "skills", "id"],
    ["skill_context_calls", "run_id", "skill_runs", "id"],
    ["skill_deploys", "approved_by", "user_identities", "id"],
  ] as const)("%s.%s → %s.%s FK", async (fromTable, fromCol, toTable, toCol) => {
    // Verify the FK actually points where it should — column AND target,
    // not just "an FK exists somewhere on this column".
    const rows = await sql<{ constraint_name: string }[]>`
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_name = kcu.table_name
      JOIN information_schema.referential_constraints rc
        ON tc.constraint_name = rc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON rc.unique_constraint_name = ccu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = ${fromTable}
        AND kcu.column_name = ${fromCol}
        AND ccu.table_name = ${toTable}
        AND ccu.column_name = ${toCol}
    `;
    expect(rows.length).toBe(1);
  });

  it.each([
    ["skill_deploys", "idx_skill_deploys_skill_id"],
    ["skill_runs", "idx_skill_runs_skill_id"],
    ["skill_context_calls", "idx_skill_context_calls_run_id"],
  ])("index %s exists on table %s", async (table, indexName) => {
    const rows = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_indexes
      WHERE tablename = ${table} AND indexname = ${indexName}
    `;
    expect(rows[0]?.count).toBe(1);
  });

  it.each([
    ["skills", "id"],
    ["skills", "name"],
    ["skills", "tier"],
    ["skills", "risk_tier"],
    ["skills", "effects"],
    ["skills", "git_sha"],
    ["skills", "inputs"],
    ["skills", "disabled"],
    ["skills", "created_at"],
    ["skill_deploys", "id"],
    ["skill_deploys", "skill_id"],
    ["skill_deploys", "git_sha"],
    ["skill_deploys", "risk_tier"],
    ["skill_deploys", "status"],
    ["skill_deploys", "classifier_log"],
    ["skill_runs", "id"],
    ["skill_runs", "skill_id"],
    ["skill_runs", "trigger"],
    ["skill_runs", "inputs"],
    ["skill_runs", "status"],
    ["skill_runs", "created_at"],
    ["skill_context_calls", "id"],
    ["skill_context_calls", "run_id"],
    ["skill_context_calls", "method"],
    ["skill_context_calls", "ok"],
    ["skill_context_calls", "created_at"],
  ] as const)("%s.%s is NOT NULL", async (table, column) => {
    const rows = await sql<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = ${table} AND column_name = ${column}
    `;
    expect(rows[0]?.is_nullable).toBe("NO");
  });

  it.each([
    ["skills", "schedule"],
    ["skills", "outputs"],
    ["skill_deploys", "prior_git_sha"],
    ["skill_deploys", "approved_by"],
    ["skill_deploys", "resolved_at"],
    ["skill_runs", "output"],
    ["skill_runs", "error"],
    ["skill_runs", "finished_at"],
    ["skill_context_calls", "target"],
    ["skill_context_calls", "error"],
  ] as const)("%s.%s is nullable (justified)", async (table, column) => {
    const rows = await sql<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = ${table} AND column_name = ${column}
    `;
    expect(rows[0]?.is_nullable).toBe("YES");
  });
});
