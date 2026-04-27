import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Inngest } from "inngest";
import { codingTaskPlanApproved, codingTaskStart } from "../../inngest/events.js";
import type { StepRun } from "../../inngest/index.js";
import { logger } from "../../logger.js";
import type { Sandbox, TaskContainerHandle } from "../../sandbox/index.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import type { CodingBackend } from "./backend.js";
import type { CodingRepoRow, CodingStore, CodingTaskRow } from "./store/index.js";
import { allocateWorktree } from "./worktree.js";

const log = logger.child({ component: "coding.orchestrator" });

export type { StepRun } from "../../inngest/index.js";

/**
 * Streaming surface the orchestrator writes to during the non-durable plan
 * phase. Slice 1 ships a no-op default; slice 1.0g wires this to
 * `TelegramStreamHandle` so the user sees the plan render in place.
 */
export interface PlanStreamHandle {
  appendText(delta: string): Promise<void>;
  finalize(plan: string): Promise<void>;
  fail(reason: string): Promise<void>;
}

export const NULL_PLAN_STREAM: PlanStreamHandle = {
  async appendText() {},
  async finalize() {},
  async fail() {},
};

/**
 * Streaming surface for the execute phase. Adds tool-call observability and
 * a `complete` terminator so the consumer (Telegram delivery, slice 2.0g)
 * can render Claude's progress in place: text deltas grow the message body,
 * tool events update an "activity" line, and `complete` flips to a final
 * status. Failures still flow through `fail`.
 */
export interface ExecuteStreamHandle {
  /** Optional — bootstrap-side wiring may publish an `execute_started` event here. */
  started?(): Promise<void>;
  appendText(delta: string): Promise<void>;
  toolCall(tool: string): Promise<void>;
  toolResult(tool: string, ok: boolean, summary?: string): Promise<void>;
  complete(ok: boolean, tokens?: { input: number; output: number }): Promise<void>;
  fail(reason: string): Promise<void>;
}

export const NULL_EXECUTE_STREAM: ExecuteStreamHandle = {
  async appendText() {},
  async toolCall() {},
  async toolResult() {},
  async complete() {},
  async fail() {},
};

export interface CodingOrchestratorDeps {
  store: CodingStore;
  sandbox: Sandbox;
  backend: CodingBackend;
  /** Default base image when the repo has no devcontainer override. */
  devbaseImage: string;
  /** Per-task resource caps. P2 reads these from `coding_repos` overrides. */
  defaultResourceLimits: ResourceLimits;
  /** Idle TTL for the task container — the reaper picks up after this expires. */
  taskTtlMs: number;
  /** Host root for per-task git worktrees — `${worktreesDir}/<repo>/<id-short>`. */
  worktreesDir: string;
  /** Open a delivery channel for streaming plan text. Slice 1 default = NULL_PLAN_STREAM. */
  openPlanStream?: (taskId: string) => Promise<PlanStreamHandle>;
  /**
   * Open a delivery channel for execute-phase progress. Default =
   * NULL_EXECUTE_STREAM. Wired to the `CodingStreamingRegistry` in
   * bootstrap (slice 2.0f), consumed by Telegram delivery in 2.0g.
   */
  openExecuteStream?: (taskId: string) => Promise<ExecuteStreamHandle>;
}

export interface CodingOrchestratorResult {
  status: "awaiting_approval" | "executing" | "failed";
  plan?: string;
  failureReason?: string;
}

const HOME_VOLUME_PREFIX = "cogmo-task-home";

export function createCodingOrchestrator(deps: CodingOrchestratorDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "coding-task-start",
      // Retries stay at 0 even now that the function is wired into Inngest
      // (slice 2.0d). The plan-mode `claude` session is non-resumable
      // from mid-stream — if Inngest replays after the session_id is
      // captured, a retry would start a fresh CLI session that doesn't
      // match what's persisted, and the user-visible streamed plan would
      // be replayed too. Failures within this function are terminal for
      // the task; the user re-delegates if they want another attempt.
      // Same constraint applies to the slice 2.0f execute function (file
      // edits inside the container aren't idempotent under retry).
      triggers: [codingTaskStart],
      retries: 0,
      // Sequentialize per task — guards against duplicate fires.
      concurrency: { limit: 1, key: "event.data.taskId" },
    },
    async ({ event, step }) => {
      return runCodingTask({ taskId: event.data.taskId, deps, stepRun: step.run });
    },
  );
}

interface RunParams {
  taskId: string;
  deps: CodingOrchestratorDeps;
  stepRun: StepRun;
}

/**
 * Pure orchestration logic. `stepRun` is Inngest's `step.run` in production
 * and an inline shim in tests — extracting this keeps the function testable
 * without booting Inngest. Type derived from the SDK so the generic
 * `Jsonify<T>` shape is preserved without re-typing it locally.
 *
 * Loads happen outside step boundaries (cheap, idempotent). Writes and
 * irreversible operations (`allocate-worktree`, `create-container`,
 * `teardown`) sit inside `stepRun` for observability and exactly-once on
 * retry.
 */
export async function runCodingTask(params: RunParams): Promise<CodingOrchestratorResult> {
  const { taskId, deps, stepRun } = params;
  const { store, sandbox, backend, devbaseImage, defaultResourceLimits, taskTtlMs, worktreesDir } =
    deps;
  const openPlanStream = deps.openPlanStream ?? (async () => NULL_PLAN_STREAM);

  const task = await store.getTask(taskId);
  if (!task) throw new Error(`coding task not found: ${taskId}`);
  const repo = await store.getRepoById(task.repoId);
  if (!repo) throw new Error(`coding repo not found: ${task.repoId}`);

  let containerCreated = false;
  // Worktree assignment may be null on a fresh task — derived from the
  // (DB-generated) task id by the allocate-worktree step below. Local
  // mutable so the rest of the function reads it without re-loading the row.
  // Single null check covers both fields (atomic by Zod schema).
  let assignment = task.worktreeAssignment;
  // Hoisted out of the try block so the catch can call planStream.fail().
  // Stays null until openPlanStream has actually returned a handle.
  let planStream: PlanStreamHandle | null = null;
  try {
    await stepRun("set-status-planning", () =>
      store.updateTaskStatus({ id: taskId, status: "planning" }),
    );

    await stepRun("allocate-worktree", async () => {
      // Idempotent reconcile: if the row already has an assignment (a
      // previous attempt persisted it), re-use; otherwise derive from the
      // task id and persist before the worktree itself is created.
      if (!assignment) {
        // 12 hex chars = 48-bit prefix of the UUIDv7 = the full unix-ms
        // timestamp portion. Two tasks created in the same millisecond
        // would still collide (~1 in 16 chance from the next nibble), but
        // single-user concurrency makes that effectively impossible.
        // Original 8 chars was just the high-order timestamp bits — every
        // task in the same ~4096-second window shared a prefix. Bad.
        const idShort = taskId.replaceAll("-", "").slice(0, 12);
        const candidatePath = join(worktreesDir, repo.name, idShort);
        // Defense in depth: refuse to create a worktree outside
        // worktreesDir even if `repo.name` somehow contains traversal
        // sequences. Repo-name validation in `Transport.repos.add` is the
        // first line; this is the second. Segment-aware to avoid rejecting
        // valid relative paths that happen to start with `..` (e.g. `..foo`
        // is a legal directory name, only `..` and `..<sep>` mean escape).
        const root = resolve(worktreesDir);
        const rel = relative(root, resolve(candidatePath));
        if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new Error(
            `worktree path escape: repo.name="${repo.name}" produced path outside worktreesDir`,
          );
        }
        assignment = {
          branch: `cogmo/${idShort}`,
          worktreePath: candidatePath,
        };
        await store.setTaskWorktreeAssignment(taskId, assignment);
      }
      await allocateWorktree({
        repoPath: repo.localPath,
        branch: assignment.branch,
        worktreePath: assignment.worktreePath,
      });
    });

    if (!assignment) {
      throw new Error("allocate-worktree completed without setting worktreeAssignment");
    }

    const created = await stepRun("create-container", async () => {
      // biome-ignore lint/style/noNonNullAssertion: guarded by the throw above
      const wt = assignment!;
      const handle = await sandbox.createTaskContainer({
        rootTaskId: taskId,
        worktreePath: wt.worktreePath,
        homeVolumeName: `${HOME_VOLUME_PREFIX}-${taskId}`,
        image: repo.devcontainer?.image ?? devbaseImage,
        resourceLimits: defaultResourceLimits,
        ttl: { expiresAt: new Date(Date.now() + taskTtlMs) },
        allowPrivilegedRunc: task.allowPrivilegedRunc,
      });
      // Mark created BEFORE the DB write so a failed setTaskContainerId
      // still triggers cleanup via the outer catch (the container exists
      // on Docker side regardless of whether we recorded it).
      containerCreated = true;
      await store.setTaskContainerId(taskId, handle.containerRowId);
      return { dockerId: handle.dockerId, containerRowId: handle.containerRowId };
    });

    // Re-derive the handle on this side of the step boundary — handles
    // can't cross step.run because they aren't JSON-serializable.
    const container = await sandbox.getTaskContainer(created.dockerId);

    // ── Non-durable: stream the plan ──
    planStream = await openPlanStream(taskId);
    // Re-load the task so the prompt template sees the row in its
    // post-allocation state (worktreeAssignment populated, container_id
    // stamped). buildPlanPrompt only reads goal + worktreeAssignment.branch
    // today, so spreading `{...task, worktreeAssignment}` would be enough —
    // but a future prompt change that reads any other lifecycle field
    // (e.g. container metadata) would silently see stale nulls. The
    // single point-read is cheap; the footgun isn't worth saving it.
    const planTask = (await store.getTask(taskId)) ?? task;
    const result = await runPlanStreaming({
      task: planTask,
      repo,
      container,
      backend,
      planStream,
      store,
    });

    if (result.isError || !result.plan) {
      const reason = result.failureReason ?? "plan phase produced no plan";
      await stepRun("set-status-failed", () =>
        store.updateTaskStatus({ id: taskId, status: "failed", failureReason: reason }),
      );
      await stepRun("teardown", () => sandbox.stopTask(taskId).catch(() => {}));
      // Stream notification post-commit — wrap so a subscriber error
      // doesn't escape into the outer catch and write a second failed
      // status that masks the original reason.
      await planStream.fail(reason).catch((streamErr: unknown) => {
        log.warn({ err: streamErr, taskId }, "plan stream fail notification failed");
      });
      return { status: "failed", failureReason: reason };
    }

    await stepRun("persist-plan", () => store.setTaskPlan(taskId, result.plan ?? ""));

    // For automated triggers (evolution, signal_pipeline) we'd auto-advance
    // straight to executing. Slice 1 only handles the user trigger path —
    // park at awaiting_approval until the human approves via Telegram.
    const nextStatus: CodingOrchestratorResult["status"] =
      task.triggerSource === "user" ? "awaiting_approval" : "executing";
    await stepRun("set-status-awaiting", () =>
      store.updateTaskStatus({ id: taskId, status: nextStatus }),
    );
    // Same wrap as the failure-path notification above — once status is
    // committed, a subscriber error must not regress the task to failed.
    await planStream.finalize(result.plan ?? "").catch((streamErr: unknown) => {
      log.warn(
        { err: streamErr, taskId },
        `plan stream finalize notification failed (task already ${nextStatus})`,
      );
    });
    return { status: nextStatus, plan: result.plan ?? "" };
  } catch (err) {
    const reason = (err as Error).message;
    log.error({ err, taskId }, "coding task failed");
    // Catch-path writes deliberately bypass `stepRun`. The function runs
    // with retries=0 (the plan-mode `claude` session is non-resumable
    // from mid-stream — see the createFunction comment), so wrapping in
    // `stepRun` here would just add observability noise without any
    // exactly-once benefit. Revisit if retries ever become non-zero.
    await store
      .updateTaskStatus({ id: taskId, status: "failed", failureReason: reason })
      .catch(() => {});
    if (containerCreated) {
      await sandbox.stopTask(taskId).catch(() => {});
    }
    // Notify the plan stream if it was opened. Best-effort — we're already
    // in the catch path, don't let a delivery failure mask the original error.
    await planStream?.fail(reason).catch(() => {});
    return { status: "failed", failureReason: reason };
  }
}

interface PlanStreamingParams {
  task: CodingTaskRow;
  repo: CodingRepoRow;
  container: TaskContainerHandle;
  backend: CodingBackend;
  planStream: PlanStreamHandle;
  store: CodingStore;
}

interface PlanStreamingResult {
  plan?: string;
  isError: boolean;
  failureReason?: string;
}

/**
 * Runs `backend.plan(ctx)` and threads its events into the plan stream and
 * the DB. Persists `session_id` as soon as it's available so a future
 * resume path (slice 2) has it.
 */
async function runPlanStreaming(params: PlanStreamingParams): Promise<PlanStreamingResult> {
  const { task, repo, container, backend, planStream, store } = params;
  let plan = "";
  let isError = false;
  let failureReason: string | undefined;

  for await (const event of backend.plan({ task, repo, container })) {
    switch (event.kind) {
      case "session_started":
        await store.setTaskSessionId(task.id, event.sessionId);
        break;
      case "text_delta":
        await planStream.appendText(event.text);
        break;
      case "plan_ready":
        plan = event.plan;
        break;
      case "complete":
        if (event.isError) {
          isError = true;
          failureReason = `claude exit code ${event.exitCode}`;
        }
        break;
      // tool_call / tool_result / permission_request: not emitted in plan mode
    }
  }

  return {
    isError,
    ...(plan && { plan }),
    ...(failureReason !== undefined && { failureReason }),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Execute phase — slice 2.0f
// ──────────────────────────────────────────────────────────────────────

export interface CodingExecuteResult {
  status: "pending_verify" | "failed" | "skipped";
  failureReason?: string;
}

/**
 * Inngest function that consumes `coding/task/plan-approved` and runs
 * `claude --resume <sid> --permission-mode acceptEdits` in the same
 * task container (recreating it if the reaper got it first).
 *
 * Same retries=0 reasoning as the plan function: file edits inside the
 * container are not idempotent under retry. A failed run leaves the
 * task in `failed`; the user re-delegates if they want another attempt.
 */
export function createCodingExecuteOrchestrator(deps: CodingOrchestratorDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "coding-task-execute",
      triggers: [codingTaskPlanApproved],
      retries: 0,
      concurrency: { limit: 1, key: "event.data.taskId" },
    },
    async ({ event, step }) => {
      return runCodingExecute({ taskId: event.data.taskId, deps, stepRun: step.run });
    },
  );
}

interface ExecuteRunParams {
  taskId: string;
  deps: CodingOrchestratorDeps;
  stepRun: StepRun;
}

/**
 * Pure execute orchestration — same `stepRun` injection pattern as
 * `runCodingTask`, so unit tests can drive it with an inline shim.
 *
 * Guards before doing real work:
 * - `plan_approved_at` must be set (the approve callback stamped it).
 * - status must be `awaiting_approval` (idempotency: a duplicate event
 *   sees `executing` or terminal and returns `skipped` without
 *   re-running claude).
 * - `session_id` must be present (the plan phase captured it).
 * - `worktree_assignment` must be present (the plan phase allocated it).
 */
export async function runCodingExecute(params: ExecuteRunParams): Promise<CodingExecuteResult> {
  const { taskId, deps, stepRun } = params;
  const { store, sandbox, backend, devbaseImage, defaultResourceLimits, taskTtlMs } = deps;
  const openExecuteStream = deps.openExecuteStream ?? (async () => NULL_EXECUTE_STREAM);

  const task = await store.getTask(taskId);
  if (!task) throw new Error(`coding task not found: ${taskId}`);
  const repo = await store.getRepoById(task.repoId);
  if (!repo) throw new Error(`coding repo not found: ${task.repoId}`);

  if (!task.planApprovedAt) {
    throw new Error(`coding task ${taskId} has no plan_approved_at — execute fired prematurely`);
  }
  if (task.status !== "awaiting_approval") {
    log.info(
      { taskId, status: task.status },
      "execute: task not in awaiting_approval — already started or terminated, skipping",
    );
    return { status: "skipped" };
  }
  if (!task.sessionId) {
    throw new Error(`coding task ${taskId} has no session_id — plan phase didn't capture it`);
  }
  if (!task.worktreeAssignment) {
    throw new Error(`coding task ${taskId} has no worktree_assignment`);
  }

  const sessionId = task.sessionId;
  const worktreeAssignment = task.worktreeAssignment;
  let containerCreated = false;
  let executeStream: ExecuteStreamHandle | null = null;

  try {
    // Conditional UPDATE: the transition only fires when the row is
    // still `awaiting_approval`, so a concurrent cancel callback that
    // already wrote `cancelled` is preserved. With retries=0 +
    // per-task concurrency=1 the race window is narrow today; the
    // conditional UPDATE pre-empts the bug for slice 3+'s
    // cancel-during-execute path at zero cost.
    const transition = await stepRun("set-status-executing", () =>
      store.transitionTaskStatus(taskId, "awaiting_approval", "executing"),
    );
    if (transition.kind !== "transitioned") {
      log.info(
        { taskId, transition },
        "execute: status transition lost the race (already cancelled or transitioned)",
      );
      return { status: "skipped" };
    }

    // Get-or-create the task container. The plan-phase container has an
    // idle TTL (CODING_TASK_IDLE_TTL_MINUTES); if approval took longer
    // than that, the reaper stopped it and we recreate. `claude --resume
    // <sid>` reloads the prior session from disk inside the container's
    // persistent home volume, so the recreate is transparent to Claude.
    const containerInfo = await stepRun("get-or-create-container", async () => {
      const existing = await findLiveContainer(sandbox, taskId);
      if (existing) return { dockerId: existing.dockerId, recreated: false };

      const handle = await sandbox.createTaskContainer({
        rootTaskId: taskId,
        worktreePath: worktreeAssignment.worktreePath,
        homeVolumeName: `${HOME_VOLUME_PREFIX}-${taskId}`,
        image: repo.devcontainer?.image ?? devbaseImage,
        resourceLimits: defaultResourceLimits,
        ttl: { expiresAt: new Date(Date.now() + taskTtlMs) },
        allowPrivilegedRunc: task.allowPrivilegedRunc,
      });
      containerCreated = true;
      await store.setTaskContainerId(taskId, handle.containerRowId);
      return { dockerId: handle.dockerId, recreated: true };
    });

    const container = await sandbox.getTaskContainer(containerInfo.dockerId);

    executeStream = await openExecuteStream(taskId);
    await executeStream.started?.();
    const result = await runExecuteStreaming({
      task,
      repo,
      container,
      backend,
      executeStream,
      sessionId,
      store,
    });

    if (result.isError) {
      const reason = result.failureReason ?? "execute phase failed";
      await stepRun("set-status-failed", () =>
        store.updateTaskStatus({ id: taskId, status: "failed", failureReason: reason }),
      );
      await stepRun("teardown", () => sandbox.stopTask(taskId).catch(() => {}));
      // Stream notifications post-commit — wrap so a subscriber failure
      // doesn't bubble into the outer catch, which would write a second
      // (less informative) failed-status overwriting the original reason.
      await executeStream.complete(false).catch((streamErr: unknown) => {
        log.warn({ err: streamErr, taskId }, "execute stream complete(false) notification failed");
      });
      await executeStream.fail(reason).catch((streamErr: unknown) => {
        log.warn({ err: streamErr, taskId }, "execute stream fail notification failed");
      });
      return { status: "failed", failureReason: reason };
    }

    if (result.usage) {
      // Replace-not-merge semantics today (see CodingStore comment): plan
      // phase doesn't write resource_usage in slice 2, so the execute
      // write is the first one and replace is fine. When slice 3+ adds
      // memory_bytes at task start, this needs to become load+merge+write
      // here OR the store contract changes to merge. The translation
      // below maps the backend's camelCase shape onto the snake_case
      // resource_usage schema (which lives at the storage layer and uses
      // SQL-friendly naming).
      const usage: Record<string, number> = {};
      if (result.usage.inputTokens != null) usage.tokens_input = result.usage.inputTokens;
      if (result.usage.outputTokens != null) usage.tokens_output = result.usage.outputTokens;
      if (result.usage.costUsd != null) usage.cost_usd = result.usage.costUsd;
      if (Object.keys(usage).length > 0) {
        await stepRun("persist-usage", () => store.setTaskResourceUsage(taskId, usage));
      }
    }

    await stepRun("set-status-pending-verify", () =>
      store.updateTaskStatus({ id: taskId, status: "pending_verify" }),
    );
    await stepRun("teardown", () => sandbox.stopTask(taskId).catch(() => {}));
    const completionTokens =
      result.usage?.inputTokens != null && result.usage?.outputTokens != null
        ? { input: result.usage.inputTokens, output: result.usage.outputTokens }
        : undefined;
    // Stream notification AFTER all the durable work has committed. Wrap
    // in `.catch` so a subscriber failure (e.g. transient Telegram API
    // error during the final edit) doesn't bubble into the outer catch
    // and regress the already-committed `pending_verify` status to
    // `failed`. The DB / sandbox state is correct; the user just won't
    // see the final progress message edit, which is recoverable on next
    // interaction.
    await executeStream.complete(true, completionTokens).catch((streamErr: unknown) => {
      log.warn(
        { err: streamErr, taskId },
        "execute stream complete notification failed (task already pending_verify)",
      );
    });
    return { status: "pending_verify" };
  } catch (err) {
    const reason = (err as Error).message;
    log.error({ err, taskId }, "coding execute failed");
    await store
      .updateTaskStatus({ id: taskId, status: "failed", failureReason: reason })
      .catch(() => {});
    if (containerCreated) {
      await sandbox.stopTask(taskId).catch(() => {});
    }
    await executeStream?.fail(reason).catch(() => {});
    return { status: "failed", failureReason: reason };
  }
}

interface ExecuteStreamingParams {
  task: CodingTaskRow;
  repo: CodingRepoRow;
  container: TaskContainerHandle;
  backend: CodingBackend;
  executeStream: ExecuteStreamHandle;
  sessionId: string;
  store: CodingStore;
}

interface ExecuteStreamingResult {
  isError: boolean;
  failureReason?: string;
  // biome-ignore lint/suspicious/noExplicitAny: BackendUsage shape is opaque to the orchestrator
  usage?: any;
}

async function runExecuteStreaming(
  params: ExecuteStreamingParams,
): Promise<ExecuteStreamingResult> {
  const { task, repo, container, backend, executeStream, sessionId } = params;
  let isError = false;
  let failureReason: string | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: BackendUsage shape is opaque to the orchestrator
  let usage: any;

  const handle = await backend.execute({ task, repo, container }, sessionId);
  for await (const event of handle.events) {
    switch (event.kind) {
      case "session_started":
        // Resumed session — usually equals task.sessionId, but we don't
        // re-persist (the plan-phase value is authoritative for slice 2).
        break;
      case "text_delta":
        await executeStream.appendText(event.text);
        break;
      case "tool_call":
        await executeStream.toolCall(event.tool);
        break;
      case "tool_result":
        await executeStream.toolResult(event.tool, event.ok, event.summary);
        break;
      case "permission_request":
        // Slice 3.0d wires the protocol but not the policy. Auto-allow
        // every request so the existing flow keeps working — slice 3.0g
        // layers policy.evaluate + decision log + Telegram prompt on top
        // of this same hook. Logged so a stray request stands out if
        // 3.0g hasn't landed yet.
        log.info(
          { taskId: task.id, requestId: event.requestId, tool: event.tool },
          "permission_request — auto-allowing (slice 3.0d default)",
        );
        await handle.respondPermission(event.requestId, { behavior: "allow" });
        break;
      case "complete":
        if (event.usage) usage = event.usage;
        if (event.isError) {
          isError = true;
          failureReason = `claude exit code ${event.exitCode}`;
        }
        break;
    }
  }

  return {
    isError,
    ...(failureReason !== undefined && { failureReason }),
    ...(usage && { usage }),
  };
}

/**
 * Find the most recently created live container for this task, or null if
 * none exist (or all are stopped/failed). Returns the `dockerId` so
 * `getTaskContainer` can re-derive a handle on the orchestrator side of a
 * step boundary.
 */
async function findLiveContainer(
  sandbox: Sandbox,
  taskId: string,
): Promise<{ dockerId: string } | null> {
  const containers = await sandbox.listContainersForTask(taskId);
  if (containers.length === 0) return null;
  // Sorted DESC by depth (children first); for a single non-nested task
  // this is just the depth-0 container. Pick the first that's still
  // running according to Docker's view.
  for (const row of containers) {
    // Skip rows the supervisor already marked terminal — it's a hint that
    // the container won't be coming back. `starting` is included because
    // the row is inserted in that state before Docker reports running;
    // a fast approve-tap could find it mid-bring-up.
    if (row.status !== "running" && row.status !== "starting") continue;
    try {
      const inspected = await sandbox.inspectContainer(row.dockerId);
      // Docker `State.Status` values: created, running, paused,
      // restarting, removing, exited, dead. Anything not running means
      // the reaper or daemon stopped it — recreate.
      if (inspected.status === "running") return { dockerId: row.dockerId };
    } catch {
      // inspectContainer throws when the container is gone (404). Skip
      // to the next candidate or fall through to "no live container".
    }
  }
  return null;
}
