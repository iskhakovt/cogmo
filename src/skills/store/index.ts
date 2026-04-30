import { and, asc, eq, sql } from "drizzle-orm";
import { single } from "../../db/helpers.js";
import type { Database } from "../../db/index.js";
import {
  type ClassifierLog,
  ClassifierLogSchema,
  type SkillEffects,
  SkillEffectsSchema,
  SkillInvocationInputsSchema,
  SkillInvocationOutputSchema,
  type SkillIo,
  SkillIoSchema,
} from "../types.js";
import { skillContextCalls, skillDeploys, skillRuns, skills } from "./schema.js";

export type SkillTier = "wasm" | "container";
export type SkillRiskTier = "auto" | "notify" | "approve";
export type SkillRunStatus = "running" | "success" | "error";
export type SkillRunTrigger = "manual" | "cron" | "event";
export type SkillDeployStatus = "pending_approval" | "approved" | "denied" | "live" | "rolled_back";

export interface SkillRow {
  id: string;
  name: string;
  tier: SkillTier;
  riskTier: SkillRiskTier;
  effects: SkillEffects;
  schedule: string | null;
  gitSha: string;
  inputs: SkillIo;
  outputs: SkillIo | null;
  disabled: boolean;
  createdAt: Date;
}

export interface SkillDeployRow {
  id: string;
  skillId: string;
  gitSha: string;
  priorGitSha: string | null;
  riskTier: SkillRiskTier;
  status: SkillDeployStatus;
  approvedBy: string | null;
  classifierLog: ClassifierLog;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface SkillRunRow {
  id: string;
  skillId: string;
  trigger: SkillRunTrigger;
  inputs: unknown;
  status: SkillRunStatus;
  output: unknown | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface SkillContextCallRow {
  id: string;
  runId: string;
  method: string;
  target: string | null;
  ok: boolean;
  error: string | null;
  createdAt: Date;
}

export interface InsertSkillParams {
  name: string;
  tier: SkillTier;
  riskTier: SkillRiskTier;
  effects: SkillEffects;
  schedule: string | null;
  gitSha: string;
  inputs: SkillIo;
  outputs: SkillIo | null;
}

export interface InsertDeployParams {
  skillId: string;
  gitSha: string;
  priorGitSha: string | null;
  riskTier: SkillRiskTier;
  status: SkillDeployStatus;
  classifierLog: ClassifierLog;
}

export interface InsertRunParams {
  skillId: string;
  trigger: SkillRunTrigger;
  inputs: unknown;
}

export interface UpdateRunResultParams {
  id: string;
  status: SkillRunStatus;
  output: unknown | null;
  error: string | null;
  finishedAt: Date;
}

export interface RecordContextCallParams {
  runId: string;
  method: string;
  target: string | null;
  ok: boolean;
  error: string | null;
}

/**
 * Atomic register operation. Caller hands in already-validated state (parsed
 * manifest, classifier output, branch tip sha) plus an `applyFilesystem`
 * callback that performs the `git update-ref refs/heads/main` advance and
 * any branch cleanup.
 *
 * The store opens one transaction, takes a per-skill-name advisory lock,
 * runs the no-op + pending-deploy checks, writes DB rows, then invokes the
 * callback so a filesystem failure throws out of the transaction and rolls
 * everything back. The remaining hole — DB commit fails after the filesystem
 * update succeeds — is small at personal scale; logged + reconcilable
 * manually via `skill_deploys` audit history.
 */
export interface ExecuteRegisterParams {
  name: string;
  tier: SkillTier;
  riskTier: SkillRiskTier;
  effects: SkillEffects;
  schedule: string | null;
  branchTipSha: string;
  inputs: SkillIo;
  outputs: SkillIo | null;
  classifierLog: ClassifierLog;
  /**
   * Called inside the register transaction *after* DB rows are written and
   * *before* the transaction commits. Throw to abort the register — the DB
   * tx will roll back.
   */
  applyFilesystem(): Promise<void>;
}

export type ExecuteRegisterResult =
  | {
      kind: "live";
      skill: SkillRow;
      deploy: SkillDeployRow;
    }
  | {
      kind: "pending_approval";
      skill: SkillRow;
      deploy: SkillDeployRow;
    }
  | {
      kind: "no_op";
      skill: SkillRow;
    }
  | {
      kind: "rejected";
      reason: string;
    };

/**
 * Atomic resolve-pending-deploy + advance-main + update-skills-row.
 *
 * Caller re-reads the manifest from git at `deploy.gitSha` and passes the full
 * set of manifest-derived columns. Without this, approving a pending deploy
 * would only flip `gitSha`/`disabled` while leaving `tier`/`riskTier`/
 * `effects`/`schedule`/`inputs`/`outputs` stale from whatever the row was
 * before the pending-approval insert — so the LLM tool definition and ajv
 * input validator would diverge from the source on disk that just got
 * promoted to main.
 */
export interface ExecuteApproveParams {
  pendingId: string;
  approvedBy: string | null;
  tier: SkillTier;
  riskTier: SkillRiskTier;
  effects: SkillEffects;
  schedule: string | null;
  inputs: SkillIo;
  outputs: SkillIo | null;
  applyFilesystem(): Promise<void>;
}

/**
 * Same projection rationale as {@link ExecuteApproveParams}: the rolled-back
 * sha may have a different manifest shape than the current live one
 * (different `inputs` schema, different `effects`, etc.); the skills row has
 * to follow.
 */
export interface ExecuteRollbackParams {
  name: string;
  toGitSha: string;
  tier: SkillTier;
  riskTier: SkillRiskTier;
  effects: SkillEffects;
  schedule: string | null;
  inputs: SkillIo;
  outputs: SkillIo | null;
  classifierLog: ClassifierLog;
  applyFilesystem(): Promise<void>;
}

export interface SkillStore {
  // --- skills ---
  insertSkill(params: InsertSkillParams): Promise<SkillRow>;
  getSkillByName(name: string): Promise<SkillRow | null>;
  getSkillById(id: string): Promise<SkillRow | null>;
  /** Live (non-disabled) rows, ordered by name for stable tool-list output. */
  listEnabledSkills(): Promise<readonly SkillRow[]>;
  updateSkillSha(params: { id: string; gitSha: string }): Promise<void>;
  setSkillDisabled(params: { id: string; disabled: boolean }): Promise<void>;
  /** P3.3: atomic register flow — see {@link ExecuteRegisterParams}. */
  executeRegister(params: ExecuteRegisterParams): Promise<ExecuteRegisterResult>;
  /** P3.3: atomic approve flow for an `approve`-tier pending deploy. */
  executeApprove(params: ExecuteApproveParams): Promise<ExecuteRegisterResult>;
  /** P3.3: atomic deny flow — resolves the pending row to `denied`, no main update. */
  denyPendingDeploy(params: { pendingId: string; reason: string | null }): Promise<void>;
  /**
   * P3.3: atomic rollback — re-points `main` and `skills.git_sha` to a prior
   * sha while inserting a new `skill_deploys` row with status `live` and
   * `prior_git_sha` set to the previous live sha.
   */
  executeRollback(params: ExecuteRollbackParams): Promise<ExecuteRegisterResult>;

  // --- skill_deploys ---
  insertDeploy(params: InsertDeployParams): Promise<SkillDeployRow>;
  /** Returns the single pending-approval deploy for a skill, or null. */
  getPendingDeploy(skillId: string): Promise<SkillDeployRow | null>;
  /** Returns the deploy row by id, or null. */
  getDeployById(id: string): Promise<SkillDeployRow | null>;
  resolveDeploy(params: {
    id: string;
    status: SkillDeployStatus;
    approvedBy: string | null;
    resolvedAt: Date;
  }): Promise<void>;

  // --- skill_runs ---
  insertRun(params: InsertRunParams): Promise<SkillRunRow>;
  updateRunResult(params: UpdateRunResultParams): Promise<void>;
  getRun(id: string): Promise<SkillRunRow | null>;

  // --- skill_context_calls ---
  recordContextCall(params: RecordContextCallParams): Promise<void>;
  listContextCallsForRun(runId: string): Promise<readonly SkillContextCallRow[]>;
}

export class DrizzleSkillStore implements SkillStore {
  #db: Database;
  constructor(db: Database) {
    this.#db = db;
  }

  // --- skills ---

  async insertSkill(params: InsertSkillParams): Promise<SkillRow> {
    const effects = SkillEffectsSchema.parse(params.effects);
    const inputs = SkillIoSchema.parse(params.inputs);
    const outputs = params.outputs === null ? null : SkillIoSchema.parse(params.outputs);
    return this.#db.transaction(async (tx) => {
      const row = single(
        await tx
          .insert(skills)
          .values({
            name: params.name,
            tier: params.tier,
            riskTier: params.riskTier,
            effects,
            schedule: params.schedule,
            gitSha: params.gitSha,
            inputs,
            outputs,
          })
          .returning(),
      );
      return parseSkillRow(row);
    });
  }

  async getSkillByName(name: string): Promise<SkillRow | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(skills).where(eq(skills.name, name)).limit(1);
      return rows[0] ? parseSkillRow(rows[0]) : null;
    });
  }

  async getSkillById(id: string): Promise<SkillRow | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(skills).where(eq(skills.id, id)).limit(1);
      return rows[0] ? parseSkillRow(rows[0]) : null;
    });
  }

  async listEnabledSkills(): Promise<readonly SkillRow[]> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(skills)
        .where(eq(skills.disabled, false))
        .orderBy(asc(skills.name));
      return rows.map(parseSkillRow);
    });
  }

  async updateSkillSha(params: { id: string; gitSha: string }): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.update(skills).set({ gitSha: params.gitSha }).where(eq(skills.id, params.id));
    });
  }

  async setSkillDisabled(params: { id: string; disabled: boolean }): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.update(skills).set({ disabled: params.disabled }).where(eq(skills.id, params.id));
    });
  }

  async executeRegister(params: ExecuteRegisterParams): Promise<ExecuteRegisterResult> {
    const effects = SkillEffectsSchema.parse(params.effects);
    const inputs = SkillIoSchema.parse(params.inputs);
    const outputs = params.outputs === null ? null : SkillIoSchema.parse(params.outputs);
    const classifierLog = ClassifierLogSchema.parse(params.classifierLog);

    return this.#db.transaction(async (tx) => {
      // Serialize concurrent registers on the same skill name. Released at
      // tx commit/rollback.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`skill_register:${params.name}`})::bigint)`,
      );

      const existingRows = await tx
        .select()
        .from(skills)
        .where(eq(skills.name, params.name))
        .limit(1);
      const existing = existingRows[0] ? parseSkillRow(existingRows[0]) : null;

      // No-op: branch tip already matches main.
      if (existing && existing.gitSha === params.branchTipSha) {
        return { kind: "no_op", skill: existing } as const;
      }

      // Pending-approval guard: refuse to start a new register while one is
      // already waiting for human approval. Caller must approve or deny first.
      if (existing) {
        const pendingRows = await tx
          .select()
          .from(skillDeploys)
          .where(
            and(eq(skillDeploys.skillId, existing.id), eq(skillDeploys.status, "pending_approval")),
          )
          .limit(1);
        if (pendingRows.length > 0) {
          return {
            kind: "rejected" as const,
            reason: "pending_deploy_exists: approve or deny the pending deploy first",
          };
        }
      }

      const goesLive = params.riskTier !== "approve";
      const deployStatus: SkillDeployStatus = goesLive ? "live" : "pending_approval";
      const priorGitSha = existing?.gitSha ?? null;

      // Apply filesystem update *before* writing DB rows so a filesystem
      // failure throws cleanly without a half-written DB. The DB writes
      // below + the tx commit are the second half; the small remaining hole
      // (commit fails after applyFilesystem succeeds) is documented in the
      // ExecuteRegisterParams comment.
      if (goesLive) {
        await params.applyFilesystem();
      }

      let skillRow: SkillRow;
      if (existing) {
        const updatedRows = await tx
          .update(skills)
          .set(
            goesLive
              ? {
                  tier: params.tier,
                  riskTier: params.riskTier,
                  effects,
                  schedule: params.schedule,
                  gitSha: params.branchTipSha,
                  inputs,
                  outputs,
                }
              : { tier: params.tier, riskTier: params.riskTier },
          )
          .where(eq(skills.id, existing.id))
          .returning();
        skillRow = parseSkillRow(single(updatedRows));
      } else {
        // First-ever deploy for this name.
        const insertedRows = await tx
          .insert(skills)
          .values({
            name: params.name,
            tier: params.tier,
            riskTier: params.riskTier,
            effects,
            schedule: params.schedule,
            gitSha: goesLive
              ? params.branchTipSha
              : // Pending-approval deploys don't yet have a live sha; reuse the
                // branch tip so the row is queryable. The skill is invisible
                // to `listEnabledSkills` until the live status flips it on
                // (via a follow-up approve), but we still need the row to
                // attach the deploy record to.
                params.branchTipSha,
            inputs,
            outputs,
            disabled: !goesLive,
          })
          .returning();
        skillRow = parseSkillRow(single(insertedRows));
      }

      const deployRows = await tx
        .insert(skillDeploys)
        .values({
          skillId: skillRow.id,
          gitSha: params.branchTipSha,
          priorGitSha,
          riskTier: params.riskTier,
          status: deployStatus,
          classifierLog,
          ...(goesLive && { resolvedAt: new Date() }),
        })
        .returning();
      const deploy = parseSkillDeployRow(single(deployRows));

      return goesLive
        ? ({ kind: "live", skill: skillRow, deploy } as const)
        : ({ kind: "pending_approval", skill: skillRow, deploy } as const);
    });
  }

  async executeApprove(params: ExecuteApproveParams): Promise<ExecuteRegisterResult> {
    const effects = SkillEffectsSchema.parse(params.effects);
    const inputs = SkillIoSchema.parse(params.inputs);
    const outputs = params.outputs === null ? null : SkillIoSchema.parse(params.outputs);

    return this.#db.transaction(async (tx) => {
      const deployRows = await tx
        .select()
        .from(skillDeploys)
        .where(eq(skillDeploys.id, params.pendingId))
        .limit(1);
      if (deployRows.length === 0) {
        return { kind: "rejected", reason: "deploy_not_found" } as const;
      }
      const deployRowRaw = deployRows[0];
      if (!deployRowRaw) {
        return { kind: "rejected", reason: "deploy_not_found" } as const;
      }
      const deploy = parseSkillDeployRow(deployRowRaw);
      if (deploy.status !== "pending_approval") {
        return {
          kind: "rejected",
          reason: `deploy_not_pending: status is '${deploy.status}'`,
        } as const;
      }

      const skillRows = await tx
        .select()
        .from(skills)
        .where(eq(skills.id, deploy.skillId))
        .limit(1);
      if (skillRows.length === 0) {
        return { kind: "rejected", reason: "skill_not_found" } as const;
      }
      const skillRow = skillRows[0];
      if (!skillRow) {
        return { kind: "rejected", reason: "skill_not_found" } as const;
      }
      const skill = parseSkillRow(skillRow);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`skill_register:${skill.name}`})::bigint)`,
      );

      // Filesystem first — same atomicity reasoning as executeRegister.
      await params.applyFilesystem();

      // Project the full manifest into the skills row alongside gitSha +
      // disabled. Approving an `approve`-tier deploy promotes the source on
      // disk to live; without copying the manifest-derived columns over, the
      // stored row would drift from what's actually at deploy.gitSha (e.g.
      // `inputs` schema would still match the prior live commit, not the
      // approved one).
      const updatedSkillRows = await tx
        .update(skills)
        .set({
          gitSha: deploy.gitSha,
          disabled: false,
          tier: params.tier,
          riskTier: params.riskTier,
          effects,
          schedule: params.schedule,
          inputs,
          outputs,
        })
        .where(eq(skills.id, skill.id))
        .returning();
      const updatedSkill = parseSkillRow(single(updatedSkillRows));

      const resolvedDeployRows = await tx
        .update(skillDeploys)
        .set({
          status: "live",
          approvedBy: params.approvedBy,
          resolvedAt: new Date(),
        })
        .where(eq(skillDeploys.id, params.pendingId))
        .returning();
      const resolvedDeploy = parseSkillDeployRow(single(resolvedDeployRows));

      return { kind: "live", skill: updatedSkill, deploy: resolvedDeploy };
    });
  }

  async denyPendingDeploy(params: { pendingId: string; reason: string | null }): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const rows = await tx
        .update(skillDeploys)
        .set({ status: "denied", resolvedAt: new Date() })
        .where(
          and(eq(skillDeploys.id, params.pendingId), eq(skillDeploys.status, "pending_approval")),
        )
        .returning();
      if (rows.length === 0) {
        // Either the id is unknown or it's already resolved. Caller can
        // distinguish by following up with getDeployById; for the deny path
        // it's acceptable to be idempotent here.
        return;
      }
      // The reason is logged via the ctx-call audit / runner-side log; not
      // stored on the deploy row to keep the schema lean. Future work can
      // add a `denied_reason` column if recall becomes useful.
      void params.reason;
    });
  }

  async executeRollback(params: ExecuteRollbackParams): Promise<ExecuteRegisterResult> {
    const classifierLog = ClassifierLogSchema.parse(params.classifierLog);
    const effects = SkillEffectsSchema.parse(params.effects);
    const inputs = SkillIoSchema.parse(params.inputs);
    const outputs = params.outputs === null ? null : SkillIoSchema.parse(params.outputs);

    return this.#db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`skill_register:${params.name}`})::bigint)`,
      );

      const skillRows = await tx.select().from(skills).where(eq(skills.name, params.name)).limit(1);
      const skillRowRaw = skillRows[0];
      if (!skillRowRaw) {
        return { kind: "rejected", reason: "skill_not_found" } as const;
      }
      const existing = parseSkillRow(skillRowRaw);
      if (existing.gitSha === params.toGitSha) {
        return { kind: "no_op", skill: existing } as const;
      }

      // Filesystem first — same atomicity reasoning as executeRegister.
      await params.applyFilesystem();

      // Project the full manifest from the rolled-back sha. Same rationale
      // as executeApprove — the prior code likely had a different `inputs`
      // schema / different declared effects, and the row has to follow.
      const updatedRows = await tx
        .update(skills)
        .set({
          gitSha: params.toGitSha,
          disabled: false,
          tier: params.tier,
          riskTier: params.riskTier,
          effects,
          schedule: params.schedule,
          inputs,
          outputs,
        })
        .where(eq(skills.id, existing.id))
        .returning();
      const updated = parseSkillRow(single(updatedRows));

      const deployRows = await tx
        .insert(skillDeploys)
        .values({
          skillId: existing.id,
          gitSha: params.toGitSha,
          priorGitSha: existing.gitSha,
          riskTier: classifierLog.risk_tier,
          status: "rolled_back",
          classifierLog,
          resolvedAt: new Date(),
        })
        .returning();
      const deploy = parseSkillDeployRow(single(deployRows));

      return { kind: "live", skill: updated, deploy };
    });
  }

  // --- skill_deploys ---

  async insertDeploy(params: InsertDeployParams): Promise<SkillDeployRow> {
    const classifierLog = ClassifierLogSchema.parse(params.classifierLog);
    return this.#db.transaction(async (tx) => {
      const row = single(
        await tx
          .insert(skillDeploys)
          .values({
            skillId: params.skillId,
            gitSha: params.gitSha,
            priorGitSha: params.priorGitSha,
            riskTier: params.riskTier,
            status: params.status,
            classifierLog,
          })
          .returning(),
      );
      return parseSkillDeployRow(row);
    });
  }

  async getPendingDeploy(skillId: string): Promise<SkillDeployRow | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(skillDeploys)
        .where(and(eq(skillDeploys.skillId, skillId), eq(skillDeploys.status, "pending_approval")))
        .limit(1);
      return rows[0] ? parseSkillDeployRow(rows[0]) : null;
    });
  }

  async getDeployById(id: string): Promise<SkillDeployRow | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(skillDeploys).where(eq(skillDeploys.id, id)).limit(1);
      return rows[0] ? parseSkillDeployRow(rows[0]) : null;
    });
  }

  async resolveDeploy(params: {
    id: string;
    status: SkillDeployStatus;
    approvedBy: string | null;
    resolvedAt: Date;
  }): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx
        .update(skillDeploys)
        .set({
          status: params.status,
          approvedBy: params.approvedBy,
          resolvedAt: params.resolvedAt,
        })
        .where(eq(skillDeploys.id, params.id));
    });
  }

  // --- skill_runs ---

  async insertRun(params: InsertRunParams): Promise<SkillRunRow> {
    if (params.inputs === null || params.inputs === undefined) {
      // skill_runs.inputs is NOT NULL by design — callers must materialize
      // an empty object rather than relying on null/undefined coercion.
      throw new Error("insertRun: inputs must not be null/undefined");
    }
    const inputs = SkillInvocationInputsSchema.parse(params.inputs);
    return this.#db.transaction(async (tx) => {
      const row = single(
        await tx
          .insert(skillRuns)
          .values({
            skillId: params.skillId,
            trigger: params.trigger,
            inputs,
            status: "running",
          })
          .returning(),
      );
      return parseSkillRunRow(row);
    });
  }

  async updateRunResult(params: UpdateRunResultParams): Promise<void> {
    const output = params.output === null ? null : SkillInvocationOutputSchema.parse(params.output);
    await this.#db.transaction(async (tx) => {
      await tx
        .update(skillRuns)
        .set({
          status: params.status,
          output,
          error: params.error,
          finishedAt: params.finishedAt,
        })
        .where(eq(skillRuns.id, params.id));
    });
  }

  async getRun(id: string): Promise<SkillRunRow | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(skillRuns).where(eq(skillRuns.id, id)).limit(1);
      return rows[0] ? parseSkillRunRow(rows[0]) : null;
    });
  }

  // --- skill_context_calls ---

  async recordContextCall(params: RecordContextCallParams): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.insert(skillContextCalls).values({
        runId: params.runId,
        method: params.method,
        target: params.target,
        ok: params.ok,
        error: params.error,
      });
    });
  }

  async listContextCallsForRun(runId: string): Promise<readonly SkillContextCallRow[]> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(skillContextCalls)
        .where(eq(skillContextCalls.runId, runId))
        .orderBy(asc(skillContextCalls.createdAt));
      return rows.map(parseSkillContextCallRow);
    });
  }
}

/**
 * Validate JSONB columns at the store boundary (CLAUDE.md: every JSONB column
 * gets a Zod schema parsed on read AND write). Drizzle marks JSONB-typed
 * columns as `unknown`; we narrow here.
 */
function parseSkillRow(row: typeof skills.$inferSelect): SkillRow {
  return {
    id: row.id,
    name: row.name,
    tier: row.tier,
    riskTier: row.riskTier,
    effects: SkillEffectsSchema.parse(row.effects),
    schedule: row.schedule,
    gitSha: row.gitSha,
    inputs: SkillIoSchema.parse(row.inputs),
    outputs: row.outputs === null ? null : SkillIoSchema.parse(row.outputs),
    disabled: row.disabled,
    createdAt: row.createdAt,
  };
}

function parseSkillDeployRow(row: typeof skillDeploys.$inferSelect): SkillDeployRow {
  return {
    id: row.id,
    skillId: row.skillId,
    gitSha: row.gitSha,
    priorGitSha: row.priorGitSha,
    riskTier: row.riskTier,
    status: row.status,
    approvedBy: row.approvedBy,
    classifierLog: ClassifierLogSchema.parse(row.classifierLog),
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

function parseSkillRunRow(row: typeof skillRuns.$inferSelect): SkillRunRow {
  return {
    id: row.id,
    skillId: row.skillId,
    trigger: row.trigger,
    inputs: SkillInvocationInputsSchema.parse(row.inputs),
    status: row.status,
    output: row.output === null ? null : SkillInvocationOutputSchema.parse(row.output),
    error: row.error,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

function parseSkillContextCallRow(row: typeof skillContextCalls.$inferSelect): SkillContextCallRow {
  return {
    id: row.id,
    runId: row.runId,
    method: row.method,
    target: row.target,
    ok: row.ok,
    error: row.error,
    createdAt: row.createdAt,
  };
}
