import { and, asc, eq, sql } from "drizzle-orm";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import type { ClassifierLog, SkillEffects, SkillInputs, SkillIo } from "../types.js";
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
  inputs: SkillInputs;
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
  inputs: SkillInputs;
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
 * callback. Both DB-write failure and filesystem failure roll the entire
 * transaction back. The only remaining inconsistency window is "tx commit
 * fails after applyFilesystem succeeded" — narrower than the reverse
 * ordering, where any DB write after FS would leave main advanced with no
 * skills row. Logged + reconcilable manually via the `skill_deploys` audit
 * history.
 */
export interface ExecuteRegisterParams {
  name: string;
  tier: SkillTier;
  riskTier: SkillRiskTier;
  effects: SkillEffects;
  schedule: string | null;
  branchTipSha: string;
  inputs: SkillInputs;
  outputs: SkillIo | null;
  classifierLog: ClassifierLog;
  /**
   * Called inside the register transaction *after* DB rows are written and
   * *before* the transaction commits. Throw to abort the register — the DB
   * tx will roll back. This is the last step before commit so a successful
   * filesystem update is followed only by the commit itself.
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
  inputs: SkillInputs;
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
  inputs: SkillInputs;
  outputs: SkillIo | null;
  classifierLog: ClassifierLog;
  applyFilesystem(): Promise<void>;
}

export interface SkillStore {
  // --- skills ---
  insertSkill(tx: Transaction, params: InsertSkillParams): Promise<SkillRow>;
  getSkillByName(tx: Transaction, name: string): Promise<SkillRow | undefined>;
  getSkillById(tx: Transaction, id: string): Promise<SkillRow | undefined>;
  /** Live (non-disabled) rows, ordered by name for stable tool-list output. */
  listEnabledSkills(tx: Transaction): Promise<readonly SkillRow[]>;
  updateSkillSha(tx: Transaction, params: { id: string; gitSha: string }): Promise<void>;
  setSkillDisabled(tx: Transaction, params: { id: string; disabled: boolean }): Promise<void>;
  /** P3.3: atomic register flow — see {@link ExecuteRegisterParams}. */
  executeRegister(tx: Transaction, params: ExecuteRegisterParams): Promise<ExecuteRegisterResult>;
  /** P3.3: atomic approve flow for an `approve`-tier pending deploy. */
  executeApprove(tx: Transaction, params: ExecuteApproveParams): Promise<ExecuteRegisterResult>;
  /** P3.3: atomic deny flow — resolves the pending row to `denied`, no main update. */
  denyPendingDeploy(
    tx: Transaction,
    params: { pendingId: string; reason: string | null },
  ): Promise<void>;
  /**
   * P3.3: atomic rollback — re-points `main` and `skills.git_sha` to a prior
   * sha while inserting a new `skill_deploys` row with status `live` and
   * `prior_git_sha` set to the previous live sha.
   */
  executeRollback(tx: Transaction, params: ExecuteRollbackParams): Promise<ExecuteRegisterResult>;

  // --- skill_deploys ---
  insertDeploy(tx: Transaction, params: InsertDeployParams): Promise<SkillDeployRow>;
  /** Returns the single pending-approval deploy for a skill, or null. */
  getPendingDeploy(tx: Transaction, skillId: string): Promise<SkillDeployRow | undefined>;
  /** Returns the deploy row by id, or null. */
  getDeployById(tx: Transaction, id: string): Promise<SkillDeployRow | undefined>;
  resolveDeploy(
    tx: Transaction,
    params: {
      id: string;
      status: SkillDeployStatus;
      approvedBy: string | null;
      resolvedAt: Date;
    },
  ): Promise<void>;

  // --- skill_runs ---
  insertRun(tx: Transaction, params: InsertRunParams): Promise<SkillRunRow>;
  updateRunResult(tx: Transaction, params: UpdateRunResultParams): Promise<void>;
  getRun(tx: Transaction, id: string): Promise<SkillRunRow | undefined>;

  // --- skill_context_calls ---
  recordContextCall(tx: Transaction, params: RecordContextCallParams): Promise<void>;
  listContextCallsForRun(tx: Transaction, runId: string): Promise<readonly SkillContextCallRow[]>;
}

export class DrizzleSkillStore implements SkillStore {
  // --- skills ---

  async insertSkill(tx: Transaction, params: InsertSkillParams): Promise<SkillRow> {
    return single(
      await tx
        .insert(skills)
        .values({
          name: params.name,
          tier: params.tier,
          riskTier: params.riskTier,
          effects: params.effects,
          schedule: params.schedule,
          gitSha: params.gitSha,
          inputs: params.inputs,
          outputs: params.outputs,
        })
        .returning(),
    );
  }

  async getSkillByName(tx: Transaction, name: string): Promise<SkillRow | undefined> {
    const rows = await tx.select().from(skills).where(eq(skills.name, name)).limit(1);
    return rows[0];
  }

  async getSkillById(tx: Transaction, id: string): Promise<SkillRow | undefined> {
    const rows = await tx.select().from(skills).where(eq(skills.id, id)).limit(1);
    return rows[0];
  }

  async listEnabledSkills(tx: Transaction): Promise<readonly SkillRow[]> {
    return tx.select().from(skills).where(eq(skills.disabled, false)).orderBy(asc(skills.name));
  }

  async updateSkillSha(tx: Transaction, params: { id: string; gitSha: string }): Promise<void> {
    await tx.update(skills).set({ gitSha: params.gitSha }).where(eq(skills.id, params.id));
  }

  async setSkillDisabled(
    tx: Transaction,
    params: { id: string; disabled: boolean },
  ): Promise<void> {
    await tx.update(skills).set({ disabled: params.disabled }).where(eq(skills.id, params.id));
  }

  async executeRegister(
    tx: Transaction,
    params: ExecuteRegisterParams,
  ): Promise<ExecuteRegisterResult> {
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
    const existing = existingRows[0];

    // No-op: branch tip already matches main AND the row is currently live.
    // The `!disabled` guard handles the deny-then-re-register case: a denied
    // pending-approval register leaves the skills row at branchTipSha but
    // disabled=true; without this check the user re-running register against
    // the same branch would get "nothing to deploy" while the skill stayed
    // dark.
    if (existing && existing.gitSha === params.branchTipSha && !existing.disabled) {
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

    // Ordering: DB writes FIRST, applyFilesystem LAST. If any DB write
    // fails, the tx rolls back before main moves; if applyFilesystem
    // fails, the tx still rolls back (we throw out of the callback). The
    // only remaining inconsistency window is "tx commit fails after
    // applyFilesystem succeeded" — narrower than "any DB write after FS
    // succeeds fails", which is what the previous FS-then-DB ordering
    // exposed. Documented on ExecuteRegisterParams.applyFilesystem.
    //
    // Pending-approval semantics for an existing skill:
    // - The currently-live skill (at existing.gitSha) STAYS LIVE during
    //   the approval window. Pending deploys live entirely on
    //   skill_deploys; the skills row is the projection of `main`, not of
    //   "what someone wants to deploy."
    // - Without this rule, queuing an approve-tier upgrade for a
    //   currently-notify skill would disable the live version for the
    //   duration of the approval — and forever if the deploy is denied
    //   (denyPendingDeploy doesn't reset the row).
    let skillRow: SkillRow;
    if (existing) {
      if (goesLive) {
        const updatedRows = await tx
          .update(skills)
          .set({
            tier: params.tier,
            riskTier: params.riskTier,
            effects: params.effects,
            schedule: params.schedule,
            gitSha: params.branchTipSha,
            inputs: params.inputs,
            outputs: params.outputs,
            disabled: false,
          })
          .where(eq(skills.id, existing.id))
          .returning();
        skillRow = single(updatedRows);
      } else {
        // Pending-approval re-deploy on a live skill — leave the existing
        // row untouched. The pending state lives on skill_deploys.
        skillRow = existing;
      }
    } else {
      // First-ever deploy for this name. Pending-approval deploys still
      // get a row (the skill_deploys row needs a skill_id FK target) but
      // it stays disabled — there's no prior live version to preserve.
      // approveDeploy flips disabled=false when the human signs off.
      const insertedRows = await tx
        .insert(skills)
        .values({
          name: params.name,
          tier: params.tier,
          riskTier: params.riskTier,
          effects: params.effects,
          schedule: params.schedule,
          gitSha: params.branchTipSha,
          inputs: params.inputs,
          outputs: params.outputs,
          disabled: !goesLive,
        })
        .returning();
      skillRow = single(insertedRows);
    }

    const deployRows = await tx
      .insert(skillDeploys)
      .values({
        skillId: skillRow.id,
        gitSha: params.branchTipSha,
        priorGitSha,
        riskTier: params.riskTier,
        status: deployStatus,
        classifierLog: params.classifierLog,
        ...(goesLive && { resolvedAt: new Date() }),
      })
      .returning();
    const deploy = single(deployRows);

    if (goesLive) {
      await params.applyFilesystem();
    }

    return goesLive
      ? ({ kind: "live", skill: skillRow, deploy } as const)
      : ({ kind: "pending_approval", skill: skillRow, deploy } as const);
  }

  async executeApprove(
    tx: Transaction,
    params: ExecuteApproveParams,
  ): Promise<ExecuteRegisterResult> {
    const deployRows = await tx
      .select()
      .from(skillDeploys)
      .where(eq(skillDeploys.id, params.pendingId))
      .limit(1);
    const deployRowRaw = deployRows[0];
    if (!deployRowRaw) {
      return { kind: "rejected", reason: "deploy_not_found" } as const;
    }
    const deploy = deployRowRaw;
    if (deploy.status !== "pending_approval") {
      return {
        kind: "rejected",
        reason: `deploy_not_pending: status is '${deploy.status}'`,
      } as const;
    }

    const skillRows = await tx.select().from(skills).where(eq(skills.id, deploy.skillId)).limit(1);
    const skillRowRaw = skillRows[0];
    if (!skillRowRaw) {
      return { kind: "rejected", reason: "skill_not_found" } as const;
    }
    const skill = skillRowRaw;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`skill_register:${skill.name}`})::bigint)`,
    );

    // Project the full manifest into the skills row alongside gitSha +
    // disabled. Approving an `approve`-tier deploy promotes the source on
    // disk to live; without copying the manifest-derived columns over, the
    // stored row would drift from what's actually at deploy.gitSha (e.g.
    // `inputs` schema would still match the prior live commit, not the
    // approved one).
    //
    // Ordering matches executeRegister: DB writes first, applyFilesystem
    // last. See the comment in executeRegister.
    const updatedSkillRows = await tx
      .update(skills)
      .set({
        gitSha: deploy.gitSha,
        disabled: false,
        tier: params.tier,
        riskTier: params.riskTier,
        effects: params.effects,
        schedule: params.schedule,
        inputs: params.inputs,
        outputs: params.outputs,
      })
      .where(eq(skills.id, skill.id))
      .returning();
    const updatedSkill = single(updatedSkillRows);

    const resolvedDeployRows = await tx
      .update(skillDeploys)
      .set({
        status: "live",
        approvedBy: params.approvedBy,
        resolvedAt: new Date(),
      })
      .where(eq(skillDeploys.id, params.pendingId))
      .returning();
    const resolvedDeploy = single(resolvedDeployRows);

    await params.applyFilesystem();

    return { kind: "live", skill: updatedSkill, deploy: resolvedDeploy };
  }

  async denyPendingDeploy(
    tx: Transaction,
    params: { pendingId: string; reason: string | null },
  ): Promise<void> {
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
  }

  async executeRollback(
    tx: Transaction,
    params: ExecuteRollbackParams,
  ): Promise<ExecuteRegisterResult> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`skill_register:${params.name}`})::bigint)`,
    );

    const skillRows = await tx.select().from(skills).where(eq(skills.name, params.name)).limit(1);
    const skillRowRaw = skillRows[0];
    if (!skillRowRaw) {
      return { kind: "rejected", reason: "skill_not_found" } as const;
    }
    const existing = skillRowRaw;
    if (existing.gitSha === params.toGitSha && !existing.disabled) {
      return { kind: "no_op", skill: existing } as const;
    }

    // Project the full manifest from the rolled-back sha. Same rationale
    // as executeApprove — the prior code likely had a different `inputs`
    // schema / different declared effects, and the row has to follow.
    // DB-first ordering matches executeRegister.
    const updatedRows = await tx
      .update(skills)
      .set({
        gitSha: params.toGitSha,
        disabled: false,
        tier: params.tier,
        riskTier: params.riskTier,
        effects: params.effects,
        schedule: params.schedule,
        inputs: params.inputs,
        outputs: params.outputs,
      })
      .where(eq(skills.id, existing.id))
      .returning();
    const updated = single(updatedRows);

    const deployRows = await tx
      .insert(skillDeploys)
      .values({
        skillId: existing.id,
        gitSha: params.toGitSha,
        priorGitSha: existing.gitSha,
        riskTier: params.classifierLog.risk_tier,
        status: "rolled_back",
        classifierLog: params.classifierLog,
        resolvedAt: new Date(),
      })
      .returning();
    const deploy = single(deployRows);

    await params.applyFilesystem();

    return { kind: "live", skill: updated, deploy };
  }

  // --- skill_deploys ---

  async insertDeploy(tx: Transaction, params: InsertDeployParams): Promise<SkillDeployRow> {
    return single(
      await tx
        .insert(skillDeploys)
        .values({
          skillId: params.skillId,
          gitSha: params.gitSha,
          priorGitSha: params.priorGitSha,
          riskTier: params.riskTier,
          status: params.status,
          classifierLog: params.classifierLog,
        })
        .returning(),
    );
  }

  async getPendingDeploy(tx: Transaction, skillId: string): Promise<SkillDeployRow | undefined> {
    const rows = await tx
      .select()
      .from(skillDeploys)
      .where(and(eq(skillDeploys.skillId, skillId), eq(skillDeploys.status, "pending_approval")))
      .limit(1);
    return rows[0];
  }

  async getDeployById(tx: Transaction, id: string): Promise<SkillDeployRow | undefined> {
    const rows = await tx.select().from(skillDeploys).where(eq(skillDeploys.id, id)).limit(1);
    return rows[0];
  }

  async resolveDeploy(
    tx: Transaction,
    params: {
      id: string;
      status: SkillDeployStatus;
      approvedBy: string | null;
      resolvedAt: Date;
    },
  ): Promise<void> {
    await tx
      .update(skillDeploys)
      .set({
        status: params.status,
        approvedBy: params.approvedBy,
        resolvedAt: params.resolvedAt,
      })
      .where(eq(skillDeploys.id, params.id));
  }

  // --- skill_runs ---

  async insertRun(tx: Transaction, params: InsertRunParams): Promise<SkillRunRow> {
    if (params.inputs === null || params.inputs === undefined) {
      // skill_runs.inputs is NOT NULL by design — callers must materialize
      // an empty object rather than relying on null/undefined coercion.
      throw new Error("insertRun: inputs must not be null/undefined");
    }
    return single(
      await tx
        .insert(skillRuns)
        .values({
          skillId: params.skillId,
          trigger: params.trigger,
          inputs: params.inputs,
          status: "running",
        })
        .returning(),
    );
  }

  async updateRunResult(tx: Transaction, params: UpdateRunResultParams): Promise<void> {
    await tx
      .update(skillRuns)
      .set({
        status: params.status,
        output: params.output,
        error: params.error,
        finishedAt: params.finishedAt,
      })
      .where(eq(skillRuns.id, params.id));
  }

  async getRun(tx: Transaction, id: string): Promise<SkillRunRow | undefined> {
    const rows = await tx.select().from(skillRuns).where(eq(skillRuns.id, id)).limit(1);
    return rows[0];
  }

  // --- skill_context_calls ---

  async recordContextCall(tx: Transaction, params: RecordContextCallParams): Promise<void> {
    await tx.insert(skillContextCalls).values({
      runId: params.runId,
      method: params.method,
      target: params.target,
      ok: params.ok,
      error: params.error,
    });
  }

  async listContextCallsForRun(
    tx: Transaction,
    runId: string,
  ): Promise<readonly SkillContextCallRow[]> {
    return tx
      .select()
      .from(skillContextCalls)
      .where(eq(skillContextCalls.runId, runId))
      .orderBy(asc(skillContextCalls.createdAt));
  }
}
