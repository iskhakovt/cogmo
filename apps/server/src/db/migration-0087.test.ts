/**
 * Migration 0087 adds `skills_repo_layout` and `skill_deploys.restores_git_sha`,
 * backfills the column on every `rolled_back` row with the row's own sha (the
 * commit an update-ref rollback restored), and installs the CHECK tying it to
 * that status. Runs the raw SQL against PGlite over deploy rows in every
 * status as a build before it wrote them (the table put back without the
 * column).
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { expectDefined } from "../test/assertions.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { Database } from "./index.js";
import { constraintNameOf, findPgErrorByCode } from "./pg-errors.js";

const MIGRATION_SQL = await readFile(
  fileURLToPath(new URL("../../migrations/0087_skills_layout_restores.sql", import.meta.url)),
  "utf8",
);

const CLASSIFIER_LOG = JSON.stringify({
  classifier_version: "stub-0",
  risk_tier: "auto",
  declared_effects: [],
  detected_effects: [],
  declared_secrets: [],
  declared_dependencies: [],
  validation_errors: [],
});

const IdRowsSchema = z.object({ rows: z.array(z.object({ id: z.string() })) });
const DeployRowsSchema = z.object({
  rows: z.array(
    z.object({ status: z.string(), git_sha: z.string(), restores_git_sha: z.string().nullable() }),
  ),
});

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});

beforeEach(async () => {
  await truncateAll(db);
  // The tables as 0087 found them.
  await db.execute(sql`DROP TABLE IF EXISTS skills_repo_layout`);
  await db.execute(
    sql`ALTER TABLE skill_deploys DROP CONSTRAINT IF EXISTS chk_skill_deploys_restores_iff_rolled_back`,
  );
  await db.execute(sql`ALTER TABLE skill_deploys DROP COLUMN IF EXISTS restores_git_sha`);
});

afterAll(async () => {
  await close();
});

/** Apply the file as `migratePerFile` does: one transaction. */
async function apply(): Promise<void> {
  const statements = MIGRATION_SQL.split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await db.transaction(async (trx) => {
    for (const stmt of statements) {
      await trx.execute(sql.raw(stmt));
    }
  });
}

async function insertSkill(): Promise<string> {
  const result = await db.execute(sql`
    INSERT INTO skills (name, tier, risk_tier, effects, git_sha, inputs)
    VALUES ('echo', 'wasm', 'auto', '[]'::jsonb, 'sha-live', '{}'::jsonb)
    RETURNING id
  `);
  return expectDefined(IdRowsSchema.parse(result).rows[0], "skill").id;
}

async function insertDeploy(skillId: string, status: string, gitSha: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO skill_deploys (skill_id, git_sha, risk_tier, status, classifier_log, resolved_at)
    VALUES (${skillId}, ${gitSha}, 'auto', ${status}::skill_deploy_status, ${CLASSIFIER_LOG}::jsonb,
      ${status === "pending_approval" ? null : "2026-01-01T00:00:00Z"}::timestamptz)
  `);
}

async function deploys(): Promise<z.infer<typeof DeployRowsSchema>["rows"]> {
  return DeployRowsSchema.parse(
    await db.execute(
      sql`SELECT status, git_sha, restores_git_sha FROM skill_deploys ORDER BY git_sha`,
    ),
  ).rows;
}

describe("migration 0087", () => {
  it("backfills restores_git_sha on rolled_back rows with their own sha, and only those", async () => {
    const skillId = await insertSkill();
    await insertDeploy(skillId, "live", "sha-a-live");
    await insertDeploy(skillId, "rolled_back", "sha-b-rolled");
    await insertDeploy(skillId, "denied", "sha-c-denied");
    await insertDeploy(skillId, "pending_approval", "sha-d-pending");

    await apply();

    expect(await deploys()).toEqual([
      { status: "live", git_sha: "sha-a-live", restores_git_sha: null },
      { status: "rolled_back", git_sha: "sha-b-rolled", restores_git_sha: "sha-b-rolled" },
      { status: "denied", git_sha: "sha-c-denied", restores_git_sha: null },
      { status: "pending_approval", git_sha: "sha-d-pending", restores_git_sha: null },
    ]);
  });

  it("then the CHECK ties restores_git_sha to rolled_back both ways, and the layout row is a singleton", async () => {
    const skillId = await insertSkill();
    await apply();

    const failure = async (write: Promise<unknown>) => {
      const error = await write.then(
        () => null,
        (e: unknown) => e,
      );
      const pg = error === null ? null : findPgErrorByCode(error, ["23514", "23505"]);
      return pg === null ? error : { code: pg.code, constraint: constraintNameOf(pg) };
    };
    const check = { code: "23514", constraint: "chk_skill_deploys_restores_iff_rolled_back" };
    expect(await failure(insertDeploy(skillId, "rolled_back", "sha-x"))).toEqual(check);
    expect(
      await failure(
        db.execute(sql`
          INSERT INTO skill_deploys (skill_id, git_sha, risk_tier, status, classifier_log, resolved_at, restores_git_sha)
          VALUES (${skillId}, 'sha-y', 'auto', 'live', ${CLASSIFIER_LOG}::jsonb, now(), 'sha-z')
        `),
      ),
    ).toEqual(check);

    await db.execute(
      sql`INSERT INTO skills_repo_layout (singleton, layout_commit_sha) VALUES (true, 'sha-layout')`,
    );
    expect(
      await failure(
        db.execute(
          sql`INSERT INTO skills_repo_layout (singleton, layout_commit_sha) VALUES (true, 'sha-other')`,
        ),
      ),
    ).toEqual({ code: "23505", constraint: "skills_repo_layout_singleton_unique" });
    expect(
      await failure(
        db.execute(
          sql`INSERT INTO skills_repo_layout (singleton, layout_commit_sha) VALUES (false, 'sha-other')`,
        ),
      ),
    ).toEqual({ code: "23514", constraint: "chk_skills_repo_layout_singleton" });
  });
});
