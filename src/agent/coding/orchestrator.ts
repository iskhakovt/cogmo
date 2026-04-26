import type { Inngest } from "inngest";
import { codingTaskStart } from "../../inngest/events.js";
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
  /** Open a delivery channel for streaming plan text. Slice 1 default = NULL_PLAN_STREAM. */
  openPlanStream?: (taskId: string) => Promise<PlanStreamHandle>;
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
      // Slice 1: retries=0. The plan-mode session is non-resumable from
      // mid-stream by us — if Inngest replays mid-streaming, the session_id
      // captured on the first attempt is stale and the retry would start a
      // fresh CLI session anyway. Slice 2 introduces explicit resume on a
      // separate trigger.
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
  const { store, sandbox, backend, devbaseImage, defaultResourceLimits, taskTtlMs } = deps;
  const openPlanStream = deps.openPlanStream ?? (async () => NULL_PLAN_STREAM);

  const task = await store.getTask(taskId);
  if (!task) throw new Error(`coding task not found: ${taskId}`);
  const repo = await store.getRepoById(task.repoId);
  if (!repo) throw new Error(`coding repo not found: ${task.repoId}`);

  let containerCreated = false;
  try {
    await stepRun("set-status-planning", () =>
      store.updateTaskStatus({ id: taskId, status: "planning" }),
    );

    await stepRun("allocate-worktree", () =>
      allocateWorktree({
        repoPath: repo.localPath,
        branch: task.branch,
        worktreePath: task.worktreePath,
      }),
    );

    const created = await stepRun("create-container", async () => {
      const handle = await sandbox.createTaskContainer({
        rootTaskId: taskId,
        worktreePath: task.worktreePath,
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
    const planStream = await openPlanStream(taskId);
    const result = await runPlanStreaming({ task, repo, container, backend, planStream, store });

    if (result.isError || !result.plan) {
      const reason = result.failureReason ?? "plan phase produced no plan";
      await stepRun("set-status-failed", () =>
        store.updateTaskStatus({ id: taskId, status: "failed", failureReason: reason }),
      );
      await stepRun("teardown", () => sandbox.stopTask(taskId).catch(() => {}));
      await planStream.fail(reason);
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
    await planStream.finalize(result.plan ?? "");
    return { status: nextStatus, plan: result.plan ?? "" };
  } catch (err) {
    const reason = (err as Error).message;
    log.error({ err, taskId }, "coding task failed");
    await store
      .updateTaskStatus({ id: taskId, status: "failed", failureReason: reason })
      .catch(() => {});
    if (containerCreated) {
      await sandbox.stopTask(taskId).catch(() => {});
    }
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
