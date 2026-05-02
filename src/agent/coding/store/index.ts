import { and, asc, count, desc, eq, ne } from "drizzle-orm";
import { single } from "../../../db/helpers.js";
import type { Database } from "../../../db/index.js";
import type { DevcontainerSpec, PrMetadata, ResourceUsage, WorktreeAssignment } from "../types.js";
import { codingRepos, codingTasks, codingToolDecisions } from "./schema.js";

export type CodingBackend = "claude" | "codex";
export type CodingTriggerSource = "user" | "evolution" | "signal_pipeline";
export type CodingTaskStatus =
  | "queued"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "pending_verify"
  | "verifying"
  | "pushed"
  | "pr_open"
  | "failed"
  | "cancelled";

export type ToolDecision = "allow" | "deny";
export type DecisionScope = "once" | "task";

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
  /**
   * Selects the GitHub identity bundle (`github_identity:<name>` in the
   * secrets table) used by the verify → push → PR pipeline for this repo.
   * Default `'default'` covers single-account setups; per-repo overrides
   * are useful when an org maintains multiple bot accounts.
   */
  identityName: string;
  /** Wall-clock cap for the post-hoc verify step (slice 4.0e). */
  verifyTimeoutSeconds: number;
  createdAt: Date;
}

export interface CodingToolDecisionRow {
  id: string;
  taskId: string;
  tool: string;
  pattern: string;
  decision: ToolDecision;
  scope: DecisionScope;
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
  /** PR state, atomic — null until 4.0g's draft-PR step populates it. */
  prMetadata: PrMetadata | null;
  status: CodingTaskStatus;
  failureReason: string | null;
  resourceUsage: ResourceUsage | null;
  createdAt: Date;
}

export interface CodingStore {
  // --- Repos ---

  /** Insert a new repo. Throws on `name` collision (UNIQUE). `identityName`
   * and `verifyTimeoutSeconds` are optional — omitted callers inherit the
   * DB defaults so single-account setups stay one-line. */
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
    identityName?: string;
    verifyTimeoutSeconds?: number;
  }): Promise<CodingRepoRow>;

  /** Look up a repo by its admin-set name. */
  getRepoByName(name: string): Promise<CodingRepoRow | undefined>;

  /** Look up a repo by id. */
  getRepoById(id: string): Promise<CodingRepoRow | undefined>;

  /** List all repos in name order. */
  listRepos(): Promise<readonly CodingRepoRow[]>;

  /** Delete a repo. Caller is responsible for cleaning up associated tasks first. */
  removeRepo(id: string): Promise<void>;

  /**
   * Atomic "delete if no active tasks" — counts active tasks and deletes the
   * repo in one transaction so a concurrent `insertTask` between the two
   * checks can't slip past. Discriminated union so the caller can't confuse
   * "didn't exist" with "deleted successfully" — both used to be `null`,
   * which made a future caller refactor a real footgun.
   */
  removeRepoIfIdle(
    id: string,
  ): Promise<{ kind: "deleted" } | { kind: "not_found" } | { kind: "in_use"; activeTasks: number }>;

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

  getTask(id: string): Promise<CodingTaskRow | undefined>;

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

  /** Persist the PR metadata blob once the draft PR is opened (slice 4.0g). */
  setTaskPrMetadata(id: string, metadata: PrMetadata): Promise<void>;

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

  /**
   * Atomic conditional status transition: `UPDATE ... SET status=$to
   * WHERE id=$1 AND status=$from RETURNING ...`. Returns the prior
   * status when the transition didn't fire (concurrent transition won
   * the race). Used at the head of the execute orchestrator to flip
   * `awaiting_approval` → `executing` without a TOCTOU gap that a
   * concurrent cancel callback could squeeze through.
   */
  transitionTaskStatus(
    id: string,
    from: CodingTaskStatus,
    to: CodingTaskStatus,
  ): Promise<
    { kind: "transitioned" } | { kind: "stale"; status: CodingTaskStatus } | { kind: "not_found" }
  >;

  /**
   * Atomic plan-approval: stamp `plan_approved_at` iff the task is still
   * `awaiting_approval` AND not already approved. Discriminated result so
   * callbacks can render the right Telegram message without a separate
   * read trip + race window. Used by the slice 2.0e callback handler.
   */
  approvePlanIfPending(
    id: string,
    approvedAt: Date,
  ): Promise<
    | { kind: "approved"; conversationId: string | null }
    | { kind: "already_approved"; approvedAt: Date }
    | { kind: "not_pending"; status: CodingTaskStatus }
    | { kind: "not_found" }
  >;

  /**
   * Atomic cancel: set status=`cancelled` iff the task is non-terminal.
   * Mirrors `approvePlanIfPending` — read+write in one transaction so a
   * concurrent state transition can't race.
   */
  cancelTaskIfActive(
    id: string,
    reason: string,
  ): Promise<
    | { kind: "cancelled"; conversationId: string | null }
    | { kind: "already_terminal"; status: CodingTaskStatus }
    | { kind: "not_found" }
  >;

  // --- Tool decisions ---

  /**
   * Record a permission decision for a task. `pattern` is the canonical
   * matcher that future requests will be checked against (when scope=`task`)
   * or the resolved request id (when scope=`once`, audit only).
   */
  insertToolDecision(params: {
    taskId: string;
    tool: string;
    pattern: string;
    decision: ToolDecision;
    scope: DecisionScope;
  }): Promise<CodingToolDecisionRow>;

  /**
   * List all decisions for a task, ordered oldest-first. The orchestrator's
   * tool-gate replays this list against incoming permission_request events
   * and applies the first matching `task`-scoped row.
   */
  listToolDecisionsForTask(taskId: string): Promise<readonly CodingToolDecisionRow[]>;
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
    identityName?: string;
    verifyTimeoutSeconds?: number;
  }): Promise<CodingRepoRow> {
    return this.#db.transaction(async (tx) => {
      const row = single(
        await tx
          .insert(codingRepos)
          .values({
            name: params.name,
            localPath: params.localPath,
            defaultBranch: params.defaultBranch,
            remoteUrl: params.remoteUrl,
            devcontainer: params.devcontainer ?? null,
            allowedBackends: [...params.allowedBackends],
            verifyCommand: params.verifyCommand,
            taskTokenBudget: params.taskTokenBudget,
            taskWallTimeSeconds: params.taskWallTimeSeconds,
            maxConcurrentTasks: params.maxConcurrentTasks,
            ...(params.identityName !== undefined && { identityName: params.identityName }),
            ...(params.verifyTimeoutSeconds !== undefined && {
              verifyTimeoutSeconds: params.verifyTimeoutSeconds,
            }),
          })
          .returning(),
      );
      return row;
    });
  }

  async getRepoByName(name: string): Promise<CodingRepoRow | undefined> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(codingRepos).where(eq(codingRepos.name, name)).limit(1);
      return rows[0];
    });
  }

  async getRepoById(id: string): Promise<CodingRepoRow | undefined> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(codingRepos).where(eq(codingRepos.id, id)).limit(1);
      return rows[0];
    });
  }

  async listRepos(): Promise<readonly CodingRepoRow[]> {
    return this.#db.transaction((tx) =>
      tx.select().from(codingRepos).orderBy(asc(codingRepos.name)),
    );
  }

  async removeRepo(id: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.delete(codingRepos).where(eq(codingRepos.id, id));
    });
  }

  async removeRepoIfIdle(
    id: string,
  ): Promise<
    { kind: "deleted" } | { kind: "not_found" } | { kind: "in_use"; activeTasks: number }
  > {
    return this.#db.transaction(async (tx) => {
      // Verify the repo exists inside the transaction so a concurrent
      // `removeRepo` racing with us doesn't leave the caller misreporting.
      const existing = await tx
        .select({ id: codingRepos.id })
        .from(codingRepos)
        .where(eq(codingRepos.id, id))
        .limit(1);
      if (existing.length === 0) return { kind: "not_found" as const };
      const conditions = TERMINAL_STATUSES.map((s) => ne(codingTasks.status, s));
      const countRows = await tx
        .select({ value: count() })
        .from(codingTasks)
        .where(and(eq(codingTasks.repoId, id), ...conditions));
      const activeTasks = countRows[0]?.value ?? 0;
      if (activeTasks > 0) return { kind: "in_use" as const, activeTasks };
      await tx.delete(codingRepos).where(eq(codingRepos.id, id));
      return { kind: "deleted" as const };
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
      return row;
    });
  }

  async setTaskWorktreeAssignment(id: string, assignment: WorktreeAssignment): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx
        .update(codingTasks)
        .set({ worktreeAssignment: assignment })
        .where(eq(codingTasks.id, id));
    });
  }

  async listTasksForConversation(conversationId: string): Promise<readonly CodingTaskRow[]> {
    return this.#db.transaction((tx) =>
      tx
        .select()
        .from(codingTasks)
        .where(eq(codingTasks.conversationId, conversationId))
        .orderBy(desc(codingTasks.createdAt)),
    );
  }

  async getTask(id: string): Promise<CodingTaskRow | undefined> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select().from(codingTasks).where(eq(codingTasks.id, id)).limit(1);
      return rows[0];
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

  async setTaskPrMetadata(id: string, metadata: PrMetadata): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.update(codingTasks).set({ prMetadata: metadata }).where(eq(codingTasks.id, id));
    });
  }

  async setTaskResourceUsage(id: string, usage: ResourceUsage): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.update(codingTasks).set({ resourceUsage: usage }).where(eq(codingTasks.id, id));
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

  async transitionTaskStatus(
    id: string,
    from: CodingTaskStatus,
    to: CodingTaskStatus,
  ): Promise<
    { kind: "transitioned" } | { kind: "stale"; status: CodingTaskStatus } | { kind: "not_found" }
  > {
    return this.#db.transaction(async (tx) => {
      // Single conditional UPDATE — atomic at the SQL level. If RETURNING
      // comes back empty, either the row doesn't exist or status didn't
      // match `from`; do a follow-up SELECT to disambiguate.
      const updated = await tx
        .update(codingTasks)
        .set({ status: to })
        .where(and(eq(codingTasks.id, id), eq(codingTasks.status, from)))
        .returning({ id: codingTasks.id });
      if (updated.length > 0) return { kind: "transitioned" as const };

      const rows = await tx
        .select({ status: codingTasks.status })
        .from(codingTasks)
        .where(eq(codingTasks.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) return { kind: "not_found" as const };
      return { kind: "stale" as const, status: row.status };
    });
  }

  async approvePlanIfPending(
    id: string,
    approvedAt: Date,
  ): Promise<
    | { kind: "approved"; conversationId: string | null }
    | { kind: "already_approved"; approvedAt: Date }
    | { kind: "not_pending"; status: CodingTaskStatus }
    | { kind: "not_found" }
  > {
    return this.#db.transaction(async (tx) => {
      // `.for('update')` row-locks the matched row so a concurrent
      // callback for the same task blocks here until our transaction
      // commits — without it, two simultaneous Telegram callback
      // deliveries can both observe `planApprovedAt = null` under
      // READ COMMITTED and both return `kind: "approved"`, double-firing
      // the plan-approved event.
      const rows = await tx
        .select({
          status: codingTasks.status,
          planApprovedAt: codingTasks.planApprovedAt,
          conversationId: codingTasks.conversationId,
        })
        .from(codingTasks)
        .where(eq(codingTasks.id, id))
        .limit(1)
        .for("update");
      const row = rows[0];
      if (!row) return { kind: "not_found" as const };
      if (row.planApprovedAt) {
        return { kind: "already_approved" as const, approvedAt: row.planApprovedAt };
      }
      if (row.status !== "awaiting_approval") {
        return { kind: "not_pending" as const, status: row.status };
      }
      await tx
        .update(codingTasks)
        .set({ planApprovedAt: approvedAt })
        .where(eq(codingTasks.id, id));
      return { kind: "approved" as const, conversationId: row.conversationId };
    });
  }

  async insertToolDecision(params: {
    taskId: string;
    tool: string;
    pattern: string;
    decision: ToolDecision;
    scope: DecisionScope;
  }): Promise<CodingToolDecisionRow> {
    return this.#db.transaction(async (tx) => {
      const row = single(
        await tx
          .insert(codingToolDecisions)
          .values({
            taskId: params.taskId,
            tool: params.tool,
            pattern: params.pattern,
            decision: params.decision,
            scope: params.scope,
          })
          .returning(),
      );
      return row;
    });
  }

  async listToolDecisionsForTask(taskId: string): Promise<readonly CodingToolDecisionRow[]> {
    return this.#db.transaction((tx) =>
      tx
        .select()
        .from(codingToolDecisions)
        .where(eq(codingToolDecisions.taskId, taskId))
        .orderBy(asc(codingToolDecisions.createdAt)),
    );
  }

  async cancelTaskIfActive(
    id: string,
    reason: string,
  ): Promise<
    | { kind: "cancelled"; conversationId: string | null }
    | { kind: "already_terminal"; status: CodingTaskStatus }
    | { kind: "not_found" }
  > {
    return this.#db.transaction(async (tx) => {
      // Same `.for('update')` reasoning as approvePlanIfPending — a
      // double-tap between approve and cancel (or two concurrent cancels)
      // could otherwise both observe the row as non-terminal and both
      // write status=cancelled with possibly different reasons.
      const rows = await tx
        .select({
          status: codingTasks.status,
          conversationId: codingTasks.conversationId,
        })
        .from(codingTasks)
        .where(eq(codingTasks.id, id))
        .limit(1)
        .for("update");
      const row = rows[0];
      if (!row) return { kind: "not_found" as const };
      if (TERMINAL_STATUSES.includes(row.status)) {
        return { kind: "already_terminal" as const, status: row.status };
      }
      await tx
        .update(codingTasks)
        .set({ status: "cancelled", failureReason: reason })
        .where(eq(codingTasks.id, id));
      return { kind: "cancelled" as const, conversationId: row.conversationId };
    });
  }
}
