/**
 * Migration 0063 adds `skills.run_as_user_id` / `run_as_profile_id`, backfills
 * every live (scheduled, enabled) skill with the install owner and the default
 * profile, then pins `chk_skills_run_as_iff_live_schedule`. Runs the raw migration SQL against
 * PGlite over rows written in the pre-migration shape (the columns dropped
 * first, since the pushed schema already has them).
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { profiles, users } from "../agent/store/schema.js";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { Database } from "./index.js";

const MIGRATION_SQL = await readFile(
  fileURLToPath(new URL("../../migrations/0063_skills_run_as.sql", import.meta.url)),
  "utf8",
);

const RunAsRowsSchema = z.object({
  rows: z.array(
    z.object({
      name: z.string(),
      run_as_user_id: z.string().nullable(),
      run_as_profile_id: z.string().nullable(),
    }),
  ),
});

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  await db.execute(sql`ALTER TABLE skills DROP CONSTRAINT chk_skills_run_as_iff_live_schedule`);
  await db.execute(sql`ALTER TABLE skills DROP COLUMN run_as_user_id`);
  await db.execute(sql`ALTER TABLE skills DROP COLUMN run_as_profile_id`);
});

afterAll(async () => {
  await close();
});

async function insertUser(): Promise<string> {
  const [row] = await db.insert(users).values({}).returning({ id: users.id });
  return expectDefined(row, "user").id;
}

async function insertProfile(name: string): Promise<string> {
  const [row] = await db
    .insert(profiles)
    .values({ userId: null, name, basePrompt: "", model: "m", toolSet: [] })
    .returning({ id: profiles.id });
  return expectDefined(row, name).id;
}

/** A skills row as the pre-migration table takes it. */
async function insertSkill(name: string, schedule: string | null, disabled = false): Promise<void> {
  await db.execute(sql`
    INSERT INTO skills (name, tier, risk_tier, effects, schedule, next_run_at, git_sha, inputs, disabled)
    VALUES (${name}, 'wasm', 'auto', '[]'::jsonb, ${schedule},
      ${schedule === null ? null : "2026-06-01T09:00:00Z"}, 'sha', '{"type":"object"}'::jsonb,
      ${disabled})
  `);
}

async function applyMigration(): Promise<void> {
  const statements = MIGRATION_SQL.split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
}

async function runAsByName(): Promise<Record<string, [string | null, string | null]>> {
  const { rows } = RunAsRowsSchema.parse(
    await db.execute(sql`SELECT name, run_as_user_id, run_as_profile_id FROM skills`),
  );
  return Object.fromEntries(rows.map((r) => [r.name, [r.run_as_user_id, r.run_as_profile_id]]));
}

describe("migration 0063 — skills run-as", () => {
  it("backfills live scheduled skills with the owner and default profile, and only those", async () => {
    const owner = await insertUser();
    await insertUser();
    const defaultProfile = await insertProfile("default");
    await insertProfile("work");
    await insertSkill("daily", "0 9 * * *");
    await insertSkill("hourly", "0 * * * *");
    await insertSkill("manual", null);
    await insertSkill("paused", "0 9 * * *", true);

    await applyMigration();

    expect(await runAsByName()).toEqual({
      daily: [owner, defaultProfile],
      hourly: [owner, defaultProfile],
      manual: [null, null],
      paused: [null, null],
    });
  });

  it("pins run-as to the schedule once applied", async () => {
    const owner = await insertUser();
    const profile = await insertProfile("default");
    await applyMigration();

    await expect(insertSkill("unowned", "0 9 * * *")).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/chk_skills_run_as_iff_live_schedule/) },
    });
    await expect(
      db.execute(sql`
        INSERT INTO skills (name, tier, risk_tier, effects, git_sha, inputs, run_as_user_id, run_as_profile_id)
        VALUES ('stray', 'wasm', 'auto', '[]'::jsonb, 'sha', '{"type":"object"}'::jsonb, ${owner}, ${profile})
      `),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/chk_skills_run_as_iff_live_schedule/) },
    });
  });
});
