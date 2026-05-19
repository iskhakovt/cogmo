import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import type {
  ClassifierLog,
  SkillEffects,
  SkillInputs,
  SkillIo,
  SkillRunResourceUsage,
} from "../types.js";
import { skillContextCalls, skillDeploys, skillRuns, skills } from "./schema.js";

/**
 * Throws if `schedule` and `scheduleNextRunAt` aren't both null or both
 * non-null. Surfaces as a TypeError before the SQL round-trip, instead of
 * letting the `chk_skills_next_run_at_iff_schedule` CHECK constraint fail
 * with an opaque Postgres error.
 */
function assertScheduleInvariant(schedule: string | null, scheduleNextRunAt: Date | null): void {
  if ((schedule === null) !== (scheduleNextRunAt === null)) {
    throw new TypeError(
      `schedule and scheduleNextRunAt must agree on null-ness (got schedule=${schedule === null ? "null" : "string"}, scheduleNextRunAt=${scheduleNextRunAt === null ? "null" : "Date"})`,
    );
  }
}

export type SkillTier = "wasm" | "container";
export type SkillRiskTier = "auto" | "notify" | "approve";
export type SkillRunStatus = "running" | "success" | "error";
export type SkillRunTrigger = "manual" | "cron" | "event";
export type SkillDeployStatus = "pending_approval" | "approved" | "denied" | "live" | "rolled_back";
/** See {@link skillRunRecoveryPoint} in schema.ts for the per-state contract. */
export type SkillRunRecoveryPoint = "started" | "executed" | "finished";

export interface SkillRow {
  id: string;
  name: string;
  tier: SkillTier;
  riskTier: SkillRiskTier;
  effects: SkillEffects;
  schedule: string | null;
  /**
   * Next scheduled fire time in UTC. Set whenever `schedule` is non-null
   * (enforced by `chk_skills_next_run_at_iff_schedule`); null otherwise.
   * The ticker queries this column.
   */
  nextRunAt: Date | null;
  /** Last fire timestamp. Null = never fired. */
  lastFiredAt: Date | null;
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
  /**
   * Per-run wall-clock + peak-memory metrics. Null while the run is in
   * `status='running'`; populated by `updateRunResult` at finalisation
   * time. Shape: {@link SkillRunResourceUsage}.
   */
  resourceUsage: SkillRunResourceUsage | null;
  /**
   * Caller-supplied deterministic token. Null for one-shot invocations
   * (CLI, ad-hoc tests). When present, the partial unique index on this
   * column plus the {@link recoveryPoint} state machine give exactly-once
   * execution semantics across retries — see `runner.invoke`.
   */
  idempotencyKey: string | null;
  /**
   * Stripe-pattern phase marker. `started` → row inserted, execute may
   * not have completed; `executed` → execute completed and its result
   * committed; `finished` → row terminal. Drives `runner.invoke`'s
   * replay branches.
   */
  recoveryPoint: SkillRunRecoveryPoint;
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
  /**
   * Required to be non-null iff `schedule` is non-null — enforced by the
   * `chk_skills_next_run_at_iff_schedule` constraint at the DB boundary. The
   * store layer additionally asserts the invariant pre-write to surface the
   * mismatch as a clear TypeError instead of a Postgres CHECK violation.
   */
  scheduleNextRunAt: Date | null;
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
  /**
   * Optional deterministic token. When provided, the row is inserted with
   * an `ON CONFLICT DO NOTHING` clause against
   * `uniq_skill_runs_idempotency_key`; the caller distinguishes "we
   * inserted" from "someone else holds the row" via
   * {@link SkillStore.startOrRecoverRun}.
   */
  idempotencyKey?: string;
}

export interface UpdateRunResultParams {
  id: string;
  status: SkillRunStatus;
  output: unknown | null;
  error: string | null;
  /**
   * Per-run metrics — `wallClockMs` is always set by the caller (host-side
   * derived from `finishedAt - createdAt`); `peakMemoryBytes` is null
   * when the runtime didn't surface a `rusage` block (tier-1 Pyodide,
   * synthesised tier-2 timeouts/crashes). See {@link SkillRunResourceUsage}.
   */
  resourceUsage: SkillRunResourceUsage;
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
  /** Non-null iff `schedule` is non-null. See {@link InsertSkillParams}. */
  scheduleNextRunAt: Date | null;
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
  /** Non-null iff `schedule` is non-null. See {@link InsertSkillParams}. */
  scheduleNextRunAt: Date | null;
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
  /** Non-null iff `schedule` is non-null. See {@link InsertSkillParams}. */
  scheduleNextRunAt: Date | null;
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
  /**
   * All rows including disabled, ordered by name. Backs the operator-facing
   * `/skills` list where seeing previously-disabled entries is the whole
   * point (you can't `/enable foo` if you've forgotten the name). Tool-list
   * paths still use {@link listEnabledSkills}.
   */
  listAllSkills(tx: Transaction): Promise<readonly SkillRow[]>;
  /**
   * True iff at least one `skill_deploys` row exists with the given
   * `(skill_id, git_sha)` and `status = 'live'`. Used by `enable` to gate
   * re-activation: a never-approved-then-denied first deploy leaves the
   * skills row at `disabled=true` with the rejected sha; `/enable foo`
   * without this check would smuggle code past the approval gate.
   * Rolled-back skills still pass (the prior live row remains).
   */
  hasLiveDeployForSkill(
    tx: Transaction,
    params: { skillId: string; gitSha: string },
  ): Promise<boolean>;
  updateSkillSha(tx: Transaction, params: { id: string; gitSha: string }): Promise<void>;
  setSkillDisabled(tx: Transaction, params: { id: string; disabled: boolean }): Promise<void>;

  /**
   * Lock and return up to `limit` rows whose `next_run_at <= now`, are not
   * disabled, and have a non-null `schedule`. Ordered by `next_run_at` ASC.
   * Uses `FOR UPDATE SKIP LOCKED` so concurrent ticker invocations don't
   * double-pick the same row.
   *
   * Caller MUST advance every returned row in the same transaction via
   * {@link advanceSkillSchedule}; otherwise the row re-fires on the next
   * tick.
   *
   * Replay-safety: the return value is captured inside the ticker's
   * `step.run("lock-and-advance", ...)`, so Inngest replays the cached
   * result on retry rather than re-executing the body.
   */
  lockDueScheduledSkills(
    tx: Transaction,
    params: { now: Date; limit: number },
  ): Promise<readonly SkillRow[]>;

  /**
   * Stamp `last_fired_at` to the timestamp that just fired and advance
   * `next_run_at` to the next occurrence. Caller computes `nextRunAt` from
   * croner. Both columns are written together to maintain the
   * `chk_skills_next_run_at_iff_schedule` invariant — this method is only
   * valid for rows with a non-null `schedule`.
   */
  advanceSkillSchedule(
    tx: Transaction,
    id: string,
    params: { lastFiredAt: Date; nextRunAt: Date },
  ): Promise<void>;
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

  /**
   * Race-safe lookup-or-create for a keyed run. Used by `runner.invoke`
   * when an idempotency key is supplied:
   *
   *   - `kind: 'new'` — the row didn't exist; we just inserted it in
   *     `recovery_point='started'`. Caller proceeds with execute.
   *   - `kind: 'recovered'` — the row existed (either a prior attempt
   *     that crashed, or a successful run being replayed). Caller
   *     branches on `row.recoveryPoint`.
   *
   * Implementation: `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING
   * RETURNING *`; when zero rows return, follow up with `SELECT ... FOR
   * UPDATE` so the recovered row is locked for the caller's transition.
   */
  startOrRecoverRun(
    tx: Transaction,
    params: { skillId: string; trigger: SkillRunTrigger; inputs: unknown; idempotencyKey: string },
  ): Promise<{ kind: "new" | "recovered"; row: SkillRunRow }>;

  /**
   * Atomic transition `started → executed`. Writes the executed payload
   * (output / error / rusage / finished_at) in the same UPDATE that
   * advances `recovery_point`. Caller wraps in `runInTx`. A retry whose
   * cached `executed` row already exists short-circuits this write via
   * the row-state check inside `runner.invoke`.
   */
  transitionToExecuted(
    tx: Transaction,
    params: {
      id: string;
      output: unknown | null;
      error: string | null;
      resourceUsage: SkillRunResourceUsage;
      finishedAt: Date;
    },
  ): Promise<void>;

  /**
   * Atomic transition `executed → finished`. Writes the terminal `status`
   * (which the execute step doesn't have — output validation runs after)
   * and flips `recovery_point` to `finished`. Output is overwritten with
   * `null` when output validation rejected the executed payload.
   */
  transitionToFinished(
    tx: Transaction,
    params: {
      id: string;
      status: SkillRunStatus;
      output: unknown | null;
      error: string | null;
    },
  ): Promise<void>;

  // --- skill_context_calls ---
  recordContextCall(tx: Transaction, params: RecordContextCallParams): Promise<void>;
  listContextCallsForRun(tx: Transaction, runId: string): Promise<readonly SkillContextCallRow[]>;
}

export class DrizzleSkillStore implements SkillStore {
  // --- skills ---

  async insertSkill(tx: Transaction, params: InsertSkillParams): Promise<SkillRow> {
    assertScheduleInvariant(params.schedule, params.scheduleNextRunAt);
    return single(
      await tx
        .insert(skills)
        .values({
          name: params.name,
          tier: params.tier,
          riskTier: params.riskTier,
          effects: params.effects,
          schedule: params.schedule,
          nextRunAt: params.scheduleNextRunAt,
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

  async listAllSkills(tx: Transaction): Promise<readonly SkillRow[]> {
    return tx.select().from(skills).orderBy(asc(skills.name));
  }

  async hasLiveDeployForSkill(
    tx: Transaction,
    params: { skillId: string; gitSha: string },
  ): Promise<boolean> {
    const rows = await tx
      .select({ id: skillDeploys.id })
      .from(skillDeploys)
      .where(
        and(
          eq(skillDeploys.skillId, params.skillId),
          eq(skillDeploys.gitSha, params.gitSha),
          eq(skillDeploys.status, "live"),
        ),
      )
      .limit(1);
    return rows.length > 0;
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

  async lockDueScheduledSkills(
    tx: Transaction,
    params: { now: Date; limit: number },
  ): Promise<readonly SkillRow[]> {
    return tx
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.disabled, false),
          isNotNull(skills.schedule),
          isNotNull(skills.nextRunAt),
          lte(skills.nextRunAt, params.now),
        ),
      )
      .orderBy(asc(skills.nextRunAt))
      .limit(params.limit)
      .for("update", { skipLocked: true });
  }

  async advanceSkillSchedule(
    tx: Transaction,
    id: string,
    params: { lastFiredAt: Date; nextRunAt: Date },
  ): Promise<void> {
    await tx
      .update(skills)
      .set({ lastFiredAt: params.lastFiredAt, nextRunAt: params.nextRunAt })
      .where(eq(skills.id, id));
  }

  async executeRegister(
    tx: Transaction,
    params: ExecuteRegisterParams,
  ): Promise<ExecuteRegisterResult> {
    assertScheduleInvariant(params.schedule, params.scheduleNextRunAt);
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
            nextRunAt: params.scheduleNextRunAt,
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
          nextRunAt: params.scheduleNextRunAt,
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
    assertScheduleInvariant(params.schedule, params.scheduleNextRunAt);
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
        nextRunAt: params.scheduleNextRunAt,
        inputs: params.inputs,
        outputs: params.outputs,
      })
      .where(eq(skills.id, skill.id))
      .returning();
    const updatedSkill = single(updatedSkillRows);

    // Guard the promote on `status = 'pending_approval'`. The earlier
    // SELECT + advisory lock narrows the race, but Tx B's stale SELECT
    // result (read before Tx A committed) is still in scope when Tx B
    // gets the lock — without the guard, B happily writes over A's
    // already-promoted state. 0 rows means we lost the race; bail.
    const resolvedDeployRows = await tx
      .update(skillDeploys)
      .set({
        status: "live",
        approvedBy: params.approvedBy,
        resolvedAt: new Date(),
      })
      .where(
        and(eq(skillDeploys.id, params.pendingId), eq(skillDeploys.status, "pending_approval")),
      )
      .returning();
    if (resolvedDeployRows.length === 0) {
      return {
        kind: "rejected",
        reason: "deploy_not_pending_at_commit: lost concurrent approval race",
      } as const;
    }
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
    assertScheduleInvariant(params.schedule, params.scheduleNextRunAt);
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
        nextRunAt: params.scheduleNextRunAt,
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
          ...(params.idempotencyKey !== undefined && {
            idempotencyKey: params.idempotencyKey,
          }),
        })
        .returning(),
    );
  }

  async startOrRecoverRun(
    tx: Transaction,
    params: { skillId: string; trigger: SkillRunTrigger; inputs: unknown; idempotencyKey: string },
  ): Promise<{ kind: "new" | "recovered"; row: SkillRunRow }> {
    if (params.inputs === null || params.inputs === undefined) {
      throw new Error("startOrRecoverRun: inputs must not be null/undefined");
    }
    // ON CONFLICT DO NOTHING — when a row with the same key already
    // exists, the INSERT no-ops and RETURNING yields zero rows. The
    // caller then re-selects with FOR UPDATE to lock the existing row.
    // Postgres requires `ON CONFLICT` against a partial unique index to
    // spell out the index's WHERE predicate so the planner can infer the
    // arbiter (`infer_arbiter_indexes` error 42P10 otherwise). Match the
    // `uniq_skill_runs_idempotency_key` definition exactly.
    const inserted = await tx
      .insert(skillRuns)
      .values({
        skillId: params.skillId,
        trigger: params.trigger,
        inputs: params.inputs,
        status: "running",
        idempotencyKey: params.idempotencyKey,
      })
      .onConflictDoNothing({
        target: skillRuns.idempotencyKey,
        where: sql`idempotency_key IS NOT NULL`,
      })
      .returning();
    if (inserted.length > 0) {
      return { kind: "new", row: single(inserted) };
    }
    // Recovered: prior attempt holds the row. Lock for our subsequent
    // UPDATE so concurrent retries serialize on this row instead of
    // racing.
    const existing = await tx
      .select()
      .from(skillRuns)
      .where(eq(skillRuns.idempotencyKey, params.idempotencyKey))
      .limit(1)
      .for("update");
    return { kind: "recovered", row: single(existing) };
  }

  async updateRunResult(tx: Transaction, params: UpdateRunResultParams): Promise<void> {
    await tx
      .update(skillRuns)
      .set({
        status: params.status,
        output: params.output,
        error: params.error,
        resourceUsage: params.resourceUsage,
        finishedAt: params.finishedAt,
      })
      .where(eq(skillRuns.id, params.id));
  }

  async transitionToExecuted(
    tx: Transaction,
    params: {
      id: string;
      output: unknown | null;
      error: string | null;
      resourceUsage: SkillRunResourceUsage;
      finishedAt: Date;
    },
  ): Promise<void> {
    await tx
      .update(skillRuns)
      .set({
        output: params.output,
        error: params.error,
        resourceUsage: params.resourceUsage,
        finishedAt: params.finishedAt,
        recoveryPoint: "executed",
      })
      .where(eq(skillRuns.id, params.id));
  }

  async transitionToFinished(
    tx: Transaction,
    params: {
      id: string;
      status: SkillRunStatus;
      output: unknown | null;
      error: string | null;
    },
  ): Promise<void> {
    await tx
      .update(skillRuns)
      .set({
        status: params.status,
        output: params.output,
        error: params.error,
        recoveryPoint: "finished",
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
