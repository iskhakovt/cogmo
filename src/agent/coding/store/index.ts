import { and, asc, count, eq, ne } from "drizzle-orm";
import { single } from "../../../db/helpers.js";
import type { Database } from "../../../db/index.js";
import {
  type DevcontainerSpec,
  DevcontainerSpecSchema,
  type ResourceUsage,
  ResourceUsageSchema,
} from "../types.js";
import { codingRepos, codingTasks } from "./schema.js";

export type CodingBackend = "claude" | "codex";
export type CodingTriggerSource = "user" | "evolution" | "signal_pipeline";
export type CodingTaskStatus =
  | "queued"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "verifying"
  | "pushed"
  | "pr_open"
  | "failed"
  | "cancelled";

const TERMINAL_STATUSES: ReadonlyArray<CodingTaskStatus> = [
  "pr_open",
  "failed",
  "cancelled",
] as const;

export interface CodingRepoRow {
  id: string;
  name: string;
  localPath: string;
  defaultBranch: string;
  remoteUrl: string;
  devcontainer: DevcontainerSpec | null;
  allowedBackends: ReadonlyArray<CodingBackend>;
  verifyCommand: string;
  taskTokenBudget: number;
  taskWallTimeSeconds: number;
  maxConcurrentTasks: number;
  createdAt: Date;
}

export interface CodingTaskRow {
  id: string;
  repoId: string;
  goal: string;
  triggerSource: CodingTriggerSource;
  triggerRef: string | null;
  backend: CodingBackend;
  branch: string;
  worktreePath: string;
  sessionId: string | null;
  containerId: string | null;
  allowPrivilegedRunc: boolean;
  plan: string | null;
  planApprovedAt: Date | null;
  prUrl: string | null;
  status: CodingTaskStatus;
  failureReason: string | null;
  resourceUsage: ResourceUsage | null;
  createdAt: Date;
}

export interface CodingStore {
  // --- Repos ---

  /** Insert a new repo. Throws on `name` collision (UNIQUE). */
  insertRepo(params: {
    name: string;
    localPath: string;
    defaultBranch: string;
    remoteUrl: string;
    devcontainer: DevcontainerSpec | null;
    allowedBackends: ReadonlyArray<CodingBackend>;
    verifyCommand: string;
    taskTokenBudget: number;
    taskWallTimeSeconds: number;
    maxConcurrentTasks: number;
  }): Promise<CodingRepoRow>;

  /** Look up a repo by its admin-set name. */
  getRepoByName(name: string): Promise<CodingRepoRow | null>;

  /** Look up a repo by id. */
  getRepoById(id: string): Promise<CodingRepoRow | null>;

  /** List all repos in name order. */
  listRepos(): Promise<readonly CodingRepoRow[]>;

  /** Delete a repo. Caller is responsible for cleaning up associated tasks first. */
  removeRepo(id: string): Promise<void>;

  // --- Tasks ---

  /** Insert a new task in `queued` status. */
  insertTask(params: {
    repoId: string;
    goal: string;
    triggerSource: CodingTriggerSource;
    triggerRef?: string | null;
    backend: CodingBackend;
    branch: string;
    worktreePath: string;
    allowPrivilegedRunc: boolean;
  }): Promise<CodingTaskRow>;

  getTask(id: string): Promise<CodingTaskRow | null>;

  /**
   * Update a task's status and optionally its `failure_reason` and
   * `plan_approved_at`. Used at every state transition.
   */
  updateTaskStatus(params: {
    id: string;
    status: CodingTaskStatus;
    failureReason?: string | null;
    planApprovedAt?: Date | null;
  }): Promise<void>;

  /** Persist the CLI session id captured on the first stream event. */
  setTaskSessionId(id: string, sessionId: string): Promise<void>;

  /** Persist the sandbox container row id once the task container is up. */
  setTaskContainerId(id: string, containerId: string): Promise<void>;

  /** Persist the plan text once the plan phase produces it. */
  setTaskPlan(id: string, plan: string): Promise<void>;

  /** Persist the PR URL once the PR is opened. */
  setTaskPrUrl(id: string, prUrl: string): Promise<void>;

  /** Merge new resource-usage fields into the JSONB column. */
  setTaskResourceUsage(id: string, usage: ResourceUsage): Promise<void>;

  /**
   * Count non-terminal tasks for a repo. Used to enforce
   * `coding_repos.max_concurrent_tasks` at admission.
   */
  countActiveTasksForRepo(repoId: string): Promise<number>;
}

export class DrizzleCodingStore implements CodingStore {
  #db: Database;
  constructor(db: Database) {
    this.#db = db;
  }

  // --- Repos ---

  async insertRepo(params: {
    name: string;
    localPath: string;
    defaultBranch: string;
    remoteUrl: string;
    devcontainer: DevcontainerSpec | null;
    allowedBackends: ReadonlyArray<CodingBackend>;
    verifyCommand: string;
    taskTokenBudget: number;
    taskWallTimeSeconds: number;
    maxConcurrentTasks: number;
  }): Promise<CodingRepoRow> {
    const devcontainer = params.devcontainer
      ? DevcontainerSpecSchema.parse(params.devcontainer)
      : null;
    return this.#db.transaction(async (tx) => {
      const row = single(
        await tx
          .insert(codingRepos)
          .values({
            name: params.name,
            localPath: params.localPath,
            defaultBranch: params.defaultBranch,
            remoteUrl: params.remoteUrl,
            devcontainer,
            allowedBackends: [...params.allowedBackends],
            verifyCommand: params.verifyCommand,
            taskTokenBudget: params.taskTokenBudget,
            taskWallTimeSeconds: params.taskWallTimeSeconds,
            maxConcurrentTasks: params.maxConcurrentTasks,
          })
          .returning(),
      );
      return parseRepoRow(row);
    });
  }

  async getRepoByName(name: string): Promise<CodingRepoRow | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(codingRepos).where(eq(codingRepos.name, name)).limit(1);
      return rows[0] ? parseRepoRow(rows[0]) : null;
    });
  }

  async getRepoById(id: string): Promise<CodingRepoRow | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(codingRepos).where(eq(codingRepos.id, id)).limit(1);
      return rows[0] ? parseRepoRow(rows[0]) : null;
    });
  }

  async listRepos(): Promise<readonly CodingRepoRow[]> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(codingRepos).orderBy(asc(codingRepos.name));
      return rows.map(parseRepoRow);
    });
  }

  async removeRepo(id: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.delete(codingRepos).where(eq(codingRepos.id, id));
    });
  }

  // --- Tasks ---

  async insertTask(params: {
    repoId: string;
    goal: string;
    triggerSource: CodingTriggerSource;
    triggerRef?: string | null;
    backend: CodingBackend;
    branch: string;
    worktreePath: string;
    allowPrivilegedRunc: boolean;
  }): Promise<CodingTaskRow> {
    return this.#db.transaction(async (tx) => {
      const row = single(
        await tx
          .insert(codingTasks)
          .values({
            repoId: params.repoId,
            goal: params.goal,
            triggerSource: params.triggerSource,
            triggerRef: params.triggerRef ?? null,
            backend: params.backend,
            branch: params.branch,
            worktreePath: params.worktreePath,
            allowPrivilegedRunc: params.allowPrivilegedRunc,
            status: "queued",
          })
          .returning(),
      );
      return parseTaskRow(row);
    });
  }

  async getTask(id: string): Promise<CodingTaskRow | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(codingTasks).where(eq(codingTasks.id, id)).limit(1);
      return rows[0] ? parseTaskRow(rows[0]) : null;
    });
  }

  async updateTaskStatus(params: {
    id: string;
    status: CodingTaskStatus;
    failureReason?: string | null;
    planApprovedAt?: Date | null;
  }): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const set: {
        status: CodingTaskStatus;
        failureReason?: string | null;
        planApprovedAt?: Date | null;
      } = { status: params.status };
      if (params.failureReason !== undefined) set.failureReason = params.failureReason;
      if (params.planApprovedAt !== undefined) set.planApprovedAt = params.planApprovedAt;
      await tx.update(codingTasks).set(set).where(eq(codingTasks.id, params.id));
    });
  }

  async setTaskSessionId(id: string, sessionId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.update(codingTasks).set({ sessionId }).where(eq(codingTasks.id, id));
    });
  }

  async setTaskContainerId(id: string, containerId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.update(codingTasks).set({ containerId }).where(eq(codingTasks.id, id));
    });
  }

  async setTaskPlan(id: string, plan: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.update(codingTasks).set({ plan }).where(eq(codingTasks.id, id));
    });
  }

  async setTaskPrUrl(id: string, prUrl: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.update(codingTasks).set({ prUrl }).where(eq(codingTasks.id, id));
    });
  }

  async setTaskResourceUsage(id: string, usage: ResourceUsage): Promise<void> {
    const parsed = ResourceUsageSchema.parse(usage);
    await this.#db.transaction(async (tx) => {
      await tx.update(codingTasks).set({ resourceUsage: parsed }).where(eq(codingTasks.id, id));
    });
  }

  async countActiveTasksForRepo(repoId: string): Promise<number> {
    return this.#db.transaction(async (tx) => {
      // Active = not in any terminal state. ne(status, 'pr_open') etc. is
      // expressed via two NEs; for three terminal values we just hard-code
      // the negation list — clearer than a sql template.
      const conditions = TERMINAL_STATUSES.map((s) => ne(codingTasks.status, s));
      const rows = await tx
        .select({ value: count() })
        .from(codingTasks)
        .where(and(eq(codingTasks.repoId, repoId), ...conditions));
      return rows[0]?.value ?? 0;
    });
  }
}

function parseRepoRow(row: typeof codingRepos.$inferSelect): CodingRepoRow {
  return {
    id: row.id,
    name: row.name,
    localPath: row.localPath,
    defaultBranch: row.defaultBranch,
    remoteUrl: row.remoteUrl,
    devcontainer: row.devcontainer ? DevcontainerSpecSchema.parse(row.devcontainer) : null,
    allowedBackends: row.allowedBackends,
    verifyCommand: row.verifyCommand,
    taskTokenBudget: row.taskTokenBudget,
    taskWallTimeSeconds: row.taskWallTimeSeconds,
    maxConcurrentTasks: row.maxConcurrentTasks,
    createdAt: row.createdAt,
  };
}

function parseTaskRow(row: typeof codingTasks.$inferSelect): CodingTaskRow {
  return {
    id: row.id,
    repoId: row.repoId,
    goal: row.goal,
    triggerSource: row.triggerSource,
    triggerRef: row.triggerRef,
    backend: row.backend,
    branch: row.branch,
    worktreePath: row.worktreePath,
    sessionId: row.sessionId,
    containerId: row.containerId,
    allowPrivilegedRunc: row.allowPrivilegedRunc,
    plan: row.plan,
    planApprovedAt: row.planApprovedAt,
    prUrl: row.prUrl,
    status: row.status,
    failureReason: row.failureReason,
    resourceUsage: row.resourceUsage ? ResourceUsageSchema.parse(row.resourceUsage) : null,
    createdAt: row.createdAt,
  };
}
