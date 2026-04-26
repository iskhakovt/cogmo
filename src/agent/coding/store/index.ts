import { and, asc, count, desc, eq, ne } from "drizzle-orm";
import { single } from "../../../db/helpers.js";
import type { Database } from "../../../db/index.js";
import {
  type DevcontainerSpec,
  DevcontainerSpecSchema,
  type ResourceUsage,
  ResourceUsageSchema,
  type WorktreeAssignment,
  WorktreeAssignmentSchema,
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
  conversationId: string | null;
  goal: string;
  triggerSource: CodingTriggerSource;
  triggerRef: string | null;
  backend: CodingBackend;
  /**
   * Branch + worktree path, atomically — null until the orchestrator's
   * `allocate-worktree` step runs, both fields populated together once it
   * does. JSONB-with-Zod under the hood; consumers do one null check and
   * get both fields typed as string.
   */
  worktreeAssignment: WorktreeAssignment | null;
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

  /**
   * Atomic "delete if no active tasks" — counts active tasks and deletes the
   * repo in one transaction so a concurrent `insertTask` between the two
   * checks can't slip past. Returns the active count if non-zero (caller
   * surfaces to the user); returns null on successful delete; returns null
   * when the repo doesn't exist (caller treats as not-found above this layer).
   */
  removeRepoIfIdle(id: string): Promise<{ activeTasks: number } | null>;

  // --- Tasks ---

  /**
   * Insert a new task in `queued` status. Branch + worktreePath are NOT
   * accepted here — the orchestrator's `allocate-worktree` step derives them
   * from the (DB-generated) task id and persists via `setTaskWorktreeAssignment`.
   */
  insertTask(params: {
    repoId: string;
    conversationId?: string | null;
    goal: string;
    triggerSource: CodingTriggerSource;
    triggerRef?: string | null;
    backend: CodingBackend;
    allowPrivilegedRunc: boolean;
  }): Promise<CodingTaskRow>;

  /** List tasks for a conversation, ordered by createdAt DESC (newest first). */
  listTasksForConversation(conversationId: string): Promise<readonly CodingTaskRow[]>;

  getTask(id: string): Promise<CodingTaskRow | null>;

  /**
   * Persist the worktree assignment derived by the orchestrator's
   * `allocate-worktree` step. JSONB-validated by `WorktreeAssignmentSchema`
   * on the way in. Called once per task; idempotent (a retry sees the
   * values already set and skips the recompute).
   */
  setTaskWorktreeAssignment(id: string, assignment: WorktreeAssignment): Promise<void>;

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

  /**
   * **Replace** (not merge) the resource_usage JSONB column with the
   * supplied object. Slice 1 only writes once per task, so replace is
   * fine; once slice 2+ stamps `memory_bytes` at task start AND
   * `tokens_*` later from `result` events, this needs to become a
   * SQL `||` JSONB merge OR the contract changes to require the caller
   * to load+merge+write. Bug pre-empted; landing the merge for the
   * single-write slice would be premature.
   */
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

  async removeRepoIfIdle(id: string): Promise<{ activeTasks: number } | null> {
    return this.#db.transaction(async (tx) => {
      // Verify the repo exists inside the transaction so a concurrent
      // `removeRepo` racing with us doesn't leave the caller misreporting.
      const existing = await tx
        .select({ id: codingRepos.id })
        .from(codingRepos)
        .where(eq(codingRepos.id, id))
        .limit(1);
      if (existing.length === 0) return null;
      const conditions = TERMINAL_STATUSES.map((s) => ne(codingTasks.status, s));
      const countRows = await tx
        .select({ value: count() })
        .from(codingTasks)
        .where(and(eq(codingTasks.repoId, id), ...conditions));
      const activeTasks = countRows[0]?.value ?? 0;
      if (activeTasks > 0) return { activeTasks };
      await tx.delete(codingRepos).where(eq(codingRepos.id, id));
      return null;
    });
  }

  // --- Tasks ---

  async insertTask(params: {
    repoId: string;
    conversationId?: string | null;
    goal: string;
    triggerSource: CodingTriggerSource;
    triggerRef?: string | null;
    backend: CodingBackend;
    allowPrivilegedRunc: boolean;
  }): Promise<CodingTaskRow> {
    return this.#db.transaction(async (tx) => {
      const row = single(
        await tx
          .insert(codingTasks)
          .values({
            repoId: params.repoId,
            conversationId: params.conversationId ?? null,
            goal: params.goal,
            triggerSource: params.triggerSource,
            triggerRef: params.triggerRef ?? null,
            backend: params.backend,
            allowPrivilegedRunc: params.allowPrivilegedRunc,
            status: "queued",
          })
          .returning(),
      );
      return parseTaskRow(row);
    });
  }

  async setTaskWorktreeAssignment(id: string, assignment: WorktreeAssignment): Promise<void> {
    const parsed = WorktreeAssignmentSchema.parse(assignment);
    await this.#db.transaction(async (tx) => {
      await tx
        .update(codingTasks)
        .set({ worktreeAssignment: parsed })
        .where(eq(codingTasks.id, id));
    });
  }

  async listTasksForConversation(conversationId: string): Promise<readonly CodingTaskRow[]> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(codingTasks)
        .where(eq(codingTasks.conversationId, conversationId))
        .orderBy(desc(codingTasks.createdAt));
      return rows.map(parseTaskRow);
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
    conversationId: row.conversationId,
    goal: row.goal,
    triggerSource: row.triggerSource,
    triggerRef: row.triggerRef,
    backend: row.backend,
    worktreeAssignment: row.worktreeAssignment
      ? WorktreeAssignmentSchema.parse(row.worktreeAssignment)
      : null,
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
