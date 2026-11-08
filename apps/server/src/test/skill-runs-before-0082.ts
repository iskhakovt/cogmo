import { sql } from "drizzle-orm";
import type { Database } from "../db/index.js";

/** The CHECKs 0082 adds, and the two it rewrites. */
const CHECKS_0082 = [
  "chk_skill_runs_error_kind_with_error",
  "chk_skill_runs_deadline_at",
  "chk_skill_runs_audit_together",
  "chk_skill_runs_executed_payload",
  "chk_skill_runs_outcome",
] as const;

const COLUMNS_0082 = [
  "error_kind",
  "deadline_at",
  "git_sha",
  "run_as_user_id",
  "run_as_profile_id",
  "shadow",
] as const;

/**
 * Put `skill_runs` back as it stood before migration 0082, on a database the
 * current schema was pushed to: without the columns, index and enum value
 * 0082 adds, and with the two CHECKs it rewrites in their 0077 form. Lets a
 * migration test write rows in the shape a build before 0082 wrote.
 */
export async function skillRunsBefore0082(db: Database): Promise<void> {
  for (const name of CHECKS_0082) {
    await db.execute(sql.raw(`ALTER TABLE skill_runs DROP CONSTRAINT IF EXISTS ${name}`));
  }
  await db.execute(sql`DROP INDEX IF EXISTS idx_skill_runs_running`);
  for (const column of COLUMNS_0082) {
    await db.execute(sql.raw(`ALTER TABLE skill_runs DROP COLUMN IF EXISTS ${column}`));
  }
  await db.execute(sql`DROP TYPE IF EXISTS skill_run_error_kind`);
  // `skill_run_recovery_point` without `dispatched`: a value can't be
  // dropped, so the type is rebuilt under the column, and the CHECK naming
  // its values with it.
  await db.execute(
    sql`ALTER TABLE skill_runs DROP CONSTRAINT IF EXISTS chk_skill_runs_status_iff_finished`,
  );
  await db.execute(sql`ALTER TABLE skill_runs ALTER COLUMN recovery_point DROP DEFAULT`);
  await db.execute(sql`ALTER TABLE skill_runs ALTER COLUMN recovery_point SET DATA TYPE text`);
  await db.execute(sql`DROP TYPE skill_run_recovery_point`);
  await db.execute(
    sql`CREATE TYPE skill_run_recovery_point AS ENUM ('started', 'executed', 'finished')`,
  );
  await db.execute(
    sql`ALTER TABLE skill_runs ALTER COLUMN recovery_point SET DATA TYPE skill_run_recovery_point USING recovery_point::skill_run_recovery_point`,
  );
  await db.execute(sql`ALTER TABLE skill_runs ALTER COLUMN recovery_point SET DEFAULT 'started'`);
  await db.execute(sql`
    ALTER TABLE skill_runs ADD CONSTRAINT chk_skill_runs_status_iff_finished
      CHECK ((recovery_point = 'finished') = (status <> 'running'))
  `);
  await db.execute(sql`
    ALTER TABLE skill_runs ADD CONSTRAINT chk_skill_runs_executed_payload CHECK (
      (recovery_point = 'started') = (finished_at IS NULL)
      AND (recovery_point = 'started') = (resource_usage IS NULL)
      AND (recovery_point <> 'started' OR (output IS NULL AND error IS NULL)))
  `);
  await db.execute(sql`
    ALTER TABLE skill_runs ADD CONSTRAINT chk_skill_runs_outcome CHECK (
      NOT (output IS NOT NULL AND error IS NOT NULL)
      AND (status <> 'success' OR error IS NULL)
      AND (status <> 'error' OR (error IS NOT NULL AND output IS NULL)))
  `);
}
