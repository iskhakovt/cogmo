import { and, asc, eq } from "drizzle-orm";
import { single } from "../../db/helpers.js";
import type { Database } from "../../db/index.js";
import {
  type ClassifierLog,
  ClassifierLogSchema,
  type SkillEffects,
  SkillEffectsSchema,
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

export interface SkillStore {
  // --- skills ---
  insertSkill(params: InsertSkillParams): Promise<SkillRow>;
  getSkillByName(name: string): Promise<SkillRow | null>;
  getSkillById(id: string): Promise<SkillRow | null>;
  /** Live (non-disabled) rows, ordered by name for stable tool-list output. */
  listEnabledSkills(): Promise<readonly SkillRow[]>;
  updateSkillSha(params: { id: string; gitSha: string }): Promise<void>;
  setSkillDisabled(params: { id: string; disabled: boolean }): Promise<void>;

  // --- skill_deploys ---
  insertDeploy(params: InsertDeployParams): Promise<SkillDeployRow>;
  /** Returns the single pending-approval deploy for a skill, or null. */
  getPendingDeploy(skillId: string): Promise<SkillDeployRow | null>;
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
    return this.#db.transaction(async (tx) => {
      const row = single(
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
      return parseSkillRunRow(row);
    });
  }

  async updateRunResult(params: UpdateRunResultParams): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx
        .update(skillRuns)
        .set({
          status: params.status,
          output: params.output ?? null,
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
    inputs: row.inputs,
    status: row.status,
    output: row.output,
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
