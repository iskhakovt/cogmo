import { and, asc, count, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { single } from "../../../db/helpers.js";
import type { Transaction } from "../../../db/index.js";
import { conversations, profiles } from "../../store/schema.js";
import {
  type DevcontainerSpec,
  type PrMetadata,
  type ResourceUsage,
  ResourceUsageSchema,
  type WorktreeAssignment,
} from "../types.js";
import { codingRepos, codingTasks } from "./schema.js";

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

const TERMINAL_STATUSES: ReadonlyArray<CodingTaskStatus> = [
  "pr_open",
  "failed",
  "cancelled",
] as const;

/** True when a task is in a state from which it will not transition further. */
export function isTerminalCodingTaskStatus(status: CodingTaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

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

export interface InsertTaskParams {
  repoId: string;
  conversationId?: string | null;
  goal: string;
  triggerSource: CodingTriggerSource;
  triggerRef?: string | null;
  backend: CodingBackend;
  allowPrivilegedRunc: boolean;
}

/**
 * Outcome of an idempotent submission. `new` = this call minted the row;
 * `recovered` = a prior call with the same key already did, so this one is
 * a retry of the same submission.
 */
export type InsertTaskResult =
  | { kind: "new"; row: CodingTaskRow }
  | { kind: "recovered"; row: CodingTaskRow };

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
  /** PR state, atomic — null until 4.0g's PR step populates it. */
  prMetadata: PrMetadata | null;
  status: CodingTaskStatus;
  failureReason: string | null;
  resourceUsage: ResourceUsage | null;
  /**
   * Caller-supplied deterministic-per-submission token, or null when the
   * caller has no retry semantics. Backed by a plain UNIQUE constraint;
   * Postgres's NULL-not-equal semantics let null-key rows coexist.
   */
  idempotencyKey: string | null;
  createdAt: Date;
}

export interface CodingStore {
  // --- Repos ---

  /** Insert a new repo. Throws on `name` collision (UNIQUE). `identityName`
   * and `verifyTimeoutSeconds` are optional — omitted callers inherit the
   * DB defaults so single-account setups stay one-line. */
  insertRepo(
    tx: Transaction,
    params: {
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
    },
  ): Promise<CodingRepoRow>;

  /** Look up a repo by its admin-set name. */
  getRepoByName(tx: Transaction, name: string): Promise<CodingRepoRow | undefined>;

  /** Look up a repo by id. */
  getRepoById(tx: Transaction, id: string): Promise<CodingRepoRow | undefined>;

  /** List all repos in name order. */
  listRepos(tx: Transaction): Promise<readonly CodingRepoRow[]>;

  /**
   * Update `remote_url` for an existing repo. Single-field method (not a
   * generic `updateRepo`) because operator-driven remote changes are the
   * one update we accept on the otherwise insert-once `coding_repos` table —
   * narrow surface keeps the "prefer immutable rows" invariant intact for
   * every other column. Used by `configureSkillsRemote` when the operator
   * picks a new URL via the wizard or the `migrate-skills-remote` CLI.
   */
  updateRepoRemoteUrl(tx: Transaction, id: string, remoteUrl: string): Promise<void>;

  /** Delete a repo. Caller is responsible for cleaning up associated tasks first. */
  removeRepo(tx: Transaction, id: string): Promise<void>;

  /**
   * Atomic "delete if no active tasks" — counts active tasks and deletes the
   * repo in one transaction so a concurrent `insertTask` between the two
   * checks can't slip past. Discriminated union so the caller can't confuse
   * "didn't exist" with "deleted successfully" — both used to be `null`,
   * which made a future caller refactor a real footgun.
   */
  removeRepoIfIdle(
    tx: Transaction,
    id: string,
  ): Promise<{ kind: "deleted" } | { kind: "not_found" } | { kind: "in_use"; activeTasks: number }>;

  // --- Tasks ---

  /**
   * Insert a new task in `queued` status. Branch + worktreePath are NOT
   * accepted here — the orchestrator's `allocate-worktree` step derives them
   * from the (DB-generated) task id and persists via `setTaskWorktreeAssignment`.
   */
  insertTask(tx: Transaction, params: InsertTaskParams): Promise<CodingTaskRow>;

  /**
   * Idempotent submission. Inserts with `ON CONFLICT DO NOTHING` against
   * `uniq_coding_tasks_idempotency_key`, so a second call carrying the same
   * key returns `kind: "recovered"` with the original row instead of
   * minting a second task. Separate from {@link CodingStore.insertTask}
   * because the contracts differ: this one can decline to insert. Mirrors
   * `SkillStore.startOrRecoverRun`.
   */
  insertOrRecoverTask(
    tx: Transaction,
    params: InsertTaskParams & { idempotencyKey: string },
  ): Promise<InsertTaskResult>;

  /**
   * Look up a submission by its idempotency key. Read-only counterpart to
   * `insertOrRecoverTask`'s conflict path — lets a caller recognise a retry
   * before spending an admission check on it.
   */
  getTaskByIdempotencyKey(tx: Transaction, key: string): Promise<CodingTaskRow | undefined>;

  /** List tasks for a conversation, ordered by createdAt DESC (newest first). */
  listTasksForConversation(
    tx: Transaction,
    conversationId: string,
  ): Promise<readonly CodingTaskRow[]>;

  getTask(tx: Transaction, id: string): Promise<CodingTaskRow | undefined>;

  /**
   * Batch lookup — returns rows for the subset of `ids` that exist. Used by
   * the orphan-run-branch sweep to avoid N round-trips for N refs. Empty
   * input returns an empty array (no SQL).
   */
  getTasksByIds(tx: Transaction, ids: ReadonlyArray<string>): Promise<readonly CodingTaskRow[]>;

  /**
   * Persist the worktree assignment derived by the orchestrator's
   * `allocate-worktree` step. JSONB-validated by `WorktreeAssignmentSchema`
   * on the way in. Called once per task; idempotent (a retry sees the
   * values already set and skips the recompute).
   */
  setTaskWorktreeAssignment(
    tx: Transaction,
    id: string,
    assignment: WorktreeAssignment,
  ): Promise<void>;

  /**
   * Update a task's status and optionally its `failure_reason` and
   * `plan_approved_at`. Used at every state transition.
   */
  updateTaskStatus(
    tx: Transaction,
    params: {
      id: string;
      status: CodingTaskStatus;
      failureReason?: string | null;
      planApprovedAt?: Date | null;
    },
  ): Promise<void>;

  /** Persist the CLI session id captured on the first stream event. */
  setTaskSessionId(tx: Transaction, id: string, sessionId: string): Promise<void>;

  /** Persist the sandbox container row id once the task container is up. */
  setTaskContainerId(tx: Transaction, id: string, containerId: string): Promise<void>;

  /** Persist the plan text once the plan phase produces it. */
  setTaskPlan(tx: Transaction, id: string, plan: string): Promise<void>;

  /** Persist the PR metadata blob once the PR is opened (slice 4.0g). */
  setTaskPrMetadata(tx: Transaction, id: string, metadata: PrMetadata): Promise<void>;

  /**
   * **Shallow-merge** `patch` into the existing `resource_usage` JSONB
   * column via Postgres `||` — atomic, single statement, no read.
   * Top-level fields in `patch` overwrite the existing values; nested
   * objects (`memory_bytes`, `sandbox`, `provisioned`) are replaced
   * wholesale, not deep-merged. Callers wanting to extend one nested
   * field's keys must either use a targeted method (e.g.
   * `setTaskSandboxDeletedAt`) or pass the full nested object.
   */
  setTaskResourceUsage(tx: Transaction, id: string, patch: Partial<ResourceUsage>): Promise<void>;

  /**
   * Stamp `resource_usage.sandbox.deleted_at` to `deletedAt` via
   * `jsonb_set` — single atomic UPDATE, no read. No-op when the
   * `sandbox` block isn't present (resume-path tasks that never wrote
   * one, or pre-3c.5 rows) or when `deleted_at` is already set
   * (idempotency under Inngest replay).
   */
  setTaskSandboxDeletedAt(tx: Transaction, id: string, deletedAt: string): Promise<void>;

  /**
   * Count non-terminal tasks for a repo. Used to enforce
   * `coding_repos.max_concurrent_tasks` at admission.
   */
  countActiveTasksForRepo(tx: Transaction, repoId: string): Promise<number>;

  /**
   * Atomic conditional fail: flip status → `failed` with the supplied
   * `failureReason` iff the row's current status is non-terminal
   * (`!= pr_open && != failed && != cancelled`). Single SQL `UPDATE ... WHERE
   * status NOT IN (...)`, returns whether the row was actually written
   * (caller can short-circuit the cleanup-event emit when it lost the race
   * against the in-worker catch path or a concurrent reconcile). Used by the
   * `coding-task-reconcile` Inngest function (`inngest/function.failed`
   * subscriber) to recover from worker disconnect / OOM where the in-worker
   * catch never ran.
   */
  failTaskIfNonTerminal(
    tx: Transaction,
    id: string,
    failureReason: string,
  ): Promise<
    | { kind: "failed" }
    | { kind: "already_terminal"; status: CodingTaskStatus }
    | { kind: "not_found" }
  >;

  /**
   * Atomic conditional status transition: `UPDATE ... SET status=$to
   * WHERE id=$1 AND status=$from RETURNING ...`. Returns the prior
   * status when the transition didn't fire (concurrent transition won
   * the race). Used at the head of the execute orchestrator to flip
   * `awaiting_approval` → `executing` without a TOCTOU gap that a
   * concurrent cancel callback could squeeze through.
   */
  transitionTaskStatus(
    tx: Transaction,
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
    tx: Transaction,
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
    tx: Transaction,
    id: string,
    reason: string,
  ): Promise<
    | { kind: "cancelled"; conversationId: string | null }
    | { kind: "already_terminal"; status: CodingTaskStatus }
    | { kind: "not_found" }
  >;

  /**
   * Resolve a task's effective `coding_autoapprove_mode` by walking
   * `coding_tasks → conversations → profiles`. Returns `null` when the
   * task has no conversation (evolution / signal-pipeline triggers) —
   * the plan orchestrator treats null as `off` since those triggers
   * already bypass the plan-approval gate by design. Used by the plan
   * orchestrator to decide whether to auto-stamp `plan_approved_at` once
   * the plan text is persisted.
   */
  getCodingAutoapproveModeForTask(tx: Transaction, taskId: string): Promise<"off" | "on" | null>;
}

/** Column values shared by both insert paths. */
function taskValues(params: InsertTaskParams) {
  return {
    repoId: params.repoId,
    conversationId: params.conversationId ?? null,
    goal: params.goal,
    triggerSource: params.triggerSource,
    triggerRef: params.triggerRef ?? null,
    backend: params.backend,
    allowPrivilegedRunc: params.allowPrivilegedRunc,
    status: "queued" as const,
  };
}

export class DrizzleCodingStore implements CodingStore {
  // --- Repos ---

  async insertRepo(
    tx: Transaction,
    params: {
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
    },
  ): Promise<CodingRepoRow> {
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
  }

  async getRepoByName(tx: Transaction, name: string): Promise<CodingRepoRow | undefined> {
    const rows = await tx.select().from(codingRepos).where(eq(codingRepos.name, name)).limit(1);
    return rows[0];
  }

  async getRepoById(tx: Transaction, id: string): Promise<CodingRepoRow | undefined> {
    const rows = await tx.select().from(codingRepos).where(eq(codingRepos.id, id)).limit(1);
    return rows[0];
  }

  async listRepos(tx: Transaction): Promise<readonly CodingRepoRow[]> {
    return tx.select().from(codingRepos).orderBy(asc(codingRepos.name));
  }

  async updateRepoRemoteUrl(tx: Transaction, id: string, remoteUrl: string): Promise<void> {
    await tx.update(codingRepos).set({ remoteUrl }).where(eq(codingRepos.id, id));
  }

  async removeRepo(tx: Transaction, id: string): Promise<void> {
    await tx.delete(codingRepos).where(eq(codingRepos.id, id));
  }

  async removeRepoIfIdle(
    tx: Transaction,
    id: string,
  ): Promise<
    { kind: "deleted" } | { kind: "not_found" } | { kind: "in_use"; activeTasks: number }
  > {
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
  }

  // --- Tasks ---

  async insertTask(tx: Transaction, params: InsertTaskParams): Promise<CodingTaskRow> {
    return single(await tx.insert(codingTasks).values(taskValues(params)).returning());
  }

  async insertOrRecoverTask(
    tx: Transaction,
    params: InsertTaskParams & { idempotencyKey: string },
  ): Promise<InsertTaskResult> {
    // ON CONFLICT DO NOTHING against `uniq_coding_tasks_idempotency_key`.
    // RETURNING yields zero rows on collision, which is the retry signal;
    // the caller's own pre-check handles the sequential case, this closes
    // the concurrent one.
    const inserted = await tx
      .insert(codingTasks)
      .values({ ...taskValues(params), idempotencyKey: params.idempotencyKey })
      .onConflictDoNothing({ target: codingTasks.idempotencyKey })
      .returning();
    if (inserted.length > 0) return { kind: "new", row: single(inserted) };
    const existing = await tx
      .select()
      .from(codingTasks)
      .where(eq(codingTasks.idempotencyKey, params.idempotencyKey))
      .limit(1);
    return { kind: "recovered", row: single(existing) };
  }

  async getTaskByIdempotencyKey(tx: Transaction, key: string): Promise<CodingTaskRow | undefined> {
    const rows = await tx
      .select()
      .from(codingTasks)
      .where(eq(codingTasks.idempotencyKey, key))
      .limit(1);
    return rows[0];
  }

  async setTaskWorktreeAssignment(
    tx: Transaction,
    id: string,
    assignment: WorktreeAssignment,
  ): Promise<void> {
    await tx
      .update(codingTasks)
      .set({ worktreeAssignment: assignment })
      .where(eq(codingTasks.id, id));
  }

  async listTasksForConversation(
    tx: Transaction,
    conversationId: string,
  ): Promise<readonly CodingTaskRow[]> {
    return tx
      .select()
      .from(codingTasks)
      .where(eq(codingTasks.conversationId, conversationId))
      .orderBy(desc(codingTasks.createdAt));
  }

  async getTask(tx: Transaction, id: string): Promise<CodingTaskRow | undefined> {
    const rows = await tx.select().from(codingTasks).where(eq(codingTasks.id, id)).limit(1);
    return rows[0];
  }

  async getTasksByIds(
    tx: Transaction,
    ids: ReadonlyArray<string>,
  ): Promise<readonly CodingTaskRow[]> {
    if (ids.length === 0) return [];
    return await tx
      .select()
      .from(codingTasks)
      .where(inArray(codingTasks.id, [...ids]));
  }

  async updateTaskStatus(
    tx: Transaction,
    params: {
      id: string;
      status: CodingTaskStatus;
      failureReason?: string | null;
      planApprovedAt?: Date | null;
    },
  ): Promise<void> {
    const set: {
      status: CodingTaskStatus;
      failureReason?: string | null;
      planApprovedAt?: Date | null;
    } = { status: params.status };
    if (params.failureReason !== undefined) set.failureReason = params.failureReason;
    if (params.planApprovedAt !== undefined) set.planApprovedAt = params.planApprovedAt;
    await tx.update(codingTasks).set(set).where(eq(codingTasks.id, params.id));
  }

  async setTaskSessionId(tx: Transaction, id: string, sessionId: string): Promise<void> {
    await tx.update(codingTasks).set({ sessionId }).where(eq(codingTasks.id, id));
  }

  async setTaskContainerId(tx: Transaction, id: string, containerId: string): Promise<void> {
    await tx.update(codingTasks).set({ containerId }).where(eq(codingTasks.id, id));
  }

  async setTaskPlan(tx: Transaction, id: string, plan: string): Promise<void> {
    await tx.update(codingTasks).set({ plan }).where(eq(codingTasks.id, id));
  }

  async setTaskPrMetadata(tx: Transaction, id: string, metadata: PrMetadata): Promise<void> {
    await tx.update(codingTasks).set({ prMetadata: metadata }).where(eq(codingTasks.id, id));
  }

  async setTaskResourceUsage(
    tx: Transaction,
    id: string,
    patch: Partial<ResourceUsage>,
  ): Promise<void> {
    // Validate the patch on its own so a malformed patch fails here at
    // the write boundary rather than at the next `fromDriver` read.
    // The raw-SQL update below bypasses the `jsonbZod` toDriver path
    // that would otherwise run validation. ResourceUsageSchema's
    // top-level fields are all optional already, but `.partial()`
    // signals intent and is robust to a future required field.
    const validated = ResourceUsageSchema.partial().parse(patch);
    await tx
      .update(codingTasks)
      .set({
        // Postgres JSONB `||` is shallow-merge — top-level keys in the
        // patch overwrite the existing column, nested objects replace
        // wholesale (matches the contract on the interface). COALESCE
        // handles the null-column case before any writes.
        resourceUsage: sql`COALESCE(${codingTasks.resourceUsage}, '{}'::jsonb) || ${JSON.stringify(validated)}::jsonb`,
      })
      .where(eq(codingTasks.id, id));
  }

  async setTaskSandboxDeletedAt(tx: Transaction, id: string, deletedAt: string): Promise<void> {
    // `jsonb_set` updates the nested `sandbox.deleted_at` path
    // atomically. The WHERE clause gates on (a) the `sandbox` block
    // existing (resume-path tasks may not have one) and (b)
    // `deleted_at` being unset, which makes the call idempotent under
    // Inngest replay even if the cached return path were ever skipped.
    await tx.execute(sql`
      UPDATE coding_tasks
      SET resource_usage = jsonb_set(
        resource_usage,
        '{sandbox,deleted_at}',
        to_jsonb(${deletedAt}::text)
      )
      WHERE id = ${id}
        AND resource_usage->'sandbox' IS NOT NULL
        AND (resource_usage->'sandbox'->>'deleted_at') IS NULL
    `);
  }

  async countActiveTasksForRepo(tx: Transaction, repoId: string): Promise<number> {
    // Active = not in any terminal state. ne(status, 'pr_open') etc. is
    // expressed via two NEs; for three terminal values we just hard-code
    // the negation list — clearer than a sql template.
    const conditions = TERMINAL_STATUSES.map((s) => ne(codingTasks.status, s));
    const rows = await tx
      .select({ value: count() })
      .from(codingTasks)
      .where(and(eq(codingTasks.repoId, repoId), ...conditions));
    return rows[0]?.value ?? 0;
  }

  async failTaskIfNonTerminal(
    tx: Transaction,
    id: string,
    failureReason: string,
  ): Promise<
    | { kind: "failed" }
    | { kind: "already_terminal"; status: CodingTaskStatus }
    | { kind: "not_found" }
  > {
    // Conditional UPDATE: only writes when the current status is
    // non-terminal. RETURNING is empty if the row is missing OR already
    // terminal; one follow-up SELECT disambiguates. Idempotent under
    // duplicate fires (a second reconcile invocation sees `failed` and
    // returns `already_terminal`).
    const updated = await tx
      .update(codingTasks)
      .set({ status: "failed", failureReason })
      .where(and(eq(codingTasks.id, id), notInArray(codingTasks.status, [...TERMINAL_STATUSES])))
      .returning({ id: codingTasks.id });
    if (updated.length > 0) return { kind: "failed" as const };

    const rows = await tx
      .select({ status: codingTasks.status })
      .from(codingTasks)
      .where(eq(codingTasks.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return { kind: "not_found" as const };
    return { kind: "already_terminal" as const, status: row.status };
  }

  async transitionTaskStatus(
    tx: Transaction,
    id: string,
    from: CodingTaskStatus,
    to: CodingTaskStatus,
  ): Promise<
    { kind: "transitioned" } | { kind: "stale"; status: CodingTaskStatus } | { kind: "not_found" }
  > {
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
  }

  async approvePlanIfPending(
    tx: Transaction,
    id: string,
    approvedAt: Date,
  ): Promise<
    | { kind: "approved"; conversationId: string | null }
    | { kind: "already_approved"; approvedAt: Date }
    | { kind: "not_pending"; status: CodingTaskStatus }
    | { kind: "not_found" }
  > {
    // `.for('update')` row-locks the matched row so a concurrent
    // callback for the same task blocks here until our transaction
    // commits — without it, two simultaneous Telegram callback
    // deliveries can both observe `planApprovedAt = null` and both
    // return `kind: "approved"`, double-firing the plan-approved
    // event. Row-locking is the right tool here regardless of
    // isolation level — REPEATABLE READ would catch the conflicting
    // UPDATE via 40001, but blocking is cheaper than retrying.
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
    await tx.update(codingTasks).set({ planApprovedAt: approvedAt }).where(eq(codingTasks.id, id));
    return { kind: "approved" as const, conversationId: row.conversationId };
  }

  async cancelTaskIfActive(
    tx: Transaction,
    id: string,
    reason: string,
  ): Promise<
    | { kind: "cancelled"; conversationId: string | null }
    | { kind: "already_terminal"; status: CodingTaskStatus }
    | { kind: "not_found" }
  > {
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
  }

  async getCodingAutoapproveModeForTask(
    tx: Transaction,
    taskId: string,
  ): Promise<"off" | "on" | null> {
    const rows = await tx
      .select({ mode: profiles.codingAutoapproveMode })
      .from(codingTasks)
      .innerJoin(conversations, eq(codingTasks.conversationId, conversations.id))
      .innerJoin(profiles, eq(conversations.profileId, profiles.id))
      .where(eq(codingTasks.id, taskId))
      .limit(1);
    return rows[0]?.mode ?? null;
  }
}
