import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import {
  codingTaskFailed,
  codingTaskPermissionDecision,
  codingTaskPermissionRequested,
  codingTaskPlanApproved,
  codingTaskStart,
} from "../../inngest/events.js";
import type { StepRun, StepSendEvent, StepWaitForEvent } from "../../inngest/index.js";
import { logger } from "../../logger.js";
import {
  isLocalDockerSessionState,
  type SandboxClient,
  type SandboxSession,
} from "../../sandbox/index.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { loadCodingSandboxEnv } from "./auth.js";
import type { BackendUsage, CodingBackend, PermissionResponse } from "./backend.js";
import { loadIdentity, pushTaskBranchToRemote, runBranchFor } from "./git-as-transport.js";
import { shortenRequestId } from "./permission-keyboard.js";
import * as policy from "./policy.js";
import type { CodingRepoRow, CodingStore, CodingTaskRow, ToolDecision } from "./store/index.js";
import { safeTeardownWorktree } from "./teardown.js";
import { canonicalPattern, replayDecisionLog } from "./tool-gate.js";
import type { WorktreeAssignment } from "./types.js";
import { allocateWorktree } from "./worktree.js";

const log = logger.child({ component: "coding.orchestrator" });

export type { StepRun, StepSendEvent } from "../../inngest/index.js";

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
  runInTx: Transactor;
  store: CodingStore;
  sandbox: SandboxClient;
  backend: CodingBackend;
  /**
   * Resolves `github_identity:<name>` rows for the failure-cascade WIP
   * push (see `teardownWorktree`). When omitted (e.g. tests that don't
   * exercise teardown), failed worktrees stay on disk.
   */
  secretsStore?: SecretsStore;
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
const WORKTREE_DIR_IN_CONTAINER = "/workspace";

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
      return runCodingTask({
        taskId: event.data.taskId,
        deps,
        stepRun: step.run,
        stepSendEvent: step.sendEvent,
        inngest,
      });
    },
  );
}

interface RunParams {
  taskId: string;
  deps: CodingOrchestratorDeps;
  stepRun: StepRun;
  /**
   * Durable bus emit. Used in the in-worker catch path so a transient
   * send blip surfaces as a function failure (caught by the
   * `coding-task-reconcile` system-event subscriber) rather than a
   * silently-swallowed `coding/task/failed` event.
   */
  stepSendEvent: StepSendEvent;
  /**
   * Inngest client — used to emit `coding/task/failed` so cleanup
   * subscribers (run-branch deletion, future telemetry) hook in
   * without polling the row.
   */
  inngest: Pick<Inngest, "send">;
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
  const { taskId, deps, stepRun, stepSendEvent, inngest } = params;
  const {
    runInTx,
    store,
    sandbox,
    backend,
    devbaseImage,
    defaultResourceLimits,
    taskTtlMs,
    worktreesDir,
  } = deps;
  const openPlanStream = deps.openPlanStream ?? (async () => NULL_PLAN_STREAM);

  const task = await runInTx((tx) => store.getTask(tx, taskId));
  if (!task) throw new Error(`coding task not found: ${taskId}`);
  const repo = await runInTx((tx) => store.getRepoById(tx, task.repoId));
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
      runInTx((tx) => store.updateTaskStatus(tx, { id: taskId, status: "planning" })),
    );

    await stepRun("allocate-worktree", async () => {
      // 12 hex chars = 48-bit prefix of the UUIDv7 = the full unix-ms
      // timestamp portion. Two tasks created in the same millisecond would
      // still collide (~1 in 16 chance from the next nibble), but single-
      // user concurrency makes that effectively impossible. Original 8
      // chars was just the high-order timestamp bits — every task in the
      // same ~4096-second window shared a prefix. Bad.
      const idShort = taskId.replaceAll("-", "").slice(0, 12);
      const branch = `cogmo/${idShort}`;

      // Idempotent reconcile: if the row already has an assignment (a
      // previous attempt persisted it), re-use; otherwise derive from the
      // task id and persist before the worktree itself is materialised.
      if (sandbox.capabilities.workingTreeTransport === "bind-mount") {
        if (!assignment) {
          const candidatePath = join(worktreesDir, repo.name, idShort);
          // Defense in depth: refuse to create a worktree outside
          // worktreesDir even if `repo.name` somehow contains traversal
          // sequences. Repo-name validation in `Transport.repos.add` is the
          // first line; this is the second. Segment-aware to avoid
          // rejecting valid relative paths that happen to start with `..`
          // (e.g. `..foo` is a legal directory name, only `..` and `..<sep>`
          // mean escape).
          const root = resolve(worktreesDir);
          const rel = relative(root, resolve(candidatePath));
          if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
            throw new Error(
              `worktree path escape: repo.name="${repo.name}" produced path outside worktreesDir`,
            );
          }
          const next: WorktreeAssignment = {
            type: "host-path",
            branch,
            worktreePath: candidatePath,
          };
          assignment = next;
          await runInTx((tx) => store.setTaskWorktreeAssignment(tx, taskId, next));
        }
        if (assignment.type !== "host-path") {
          throw new Error(
            `bind-mount backend requires host-path worktree assignment, got ${assignment.type}`,
          );
        }
        await allocateWorktree({
          repoPath: repo.localPath,
          branch: assignment.branch,
          worktreePath: assignment.worktreePath,
        });
      } else {
        // git-remote: no host worktree. The orchestrator force-pushes the
        // current default-branch tip to `cogmo/run/<task-id>` so the
        // sandbox can clone it on `create()`. The slice-4 feature branch
        // (`cogmo/<idShort>`) is checked out inside the sandbox after
        // create — see `create-container` step.
        if (!deps.secretsStore) {
          throw new Error(
            "git-remote sandbox requires a secretsStore to resolve the GitHub identity for the run-branch push",
          );
        }
        if (!assignment) {
          const next: WorktreeAssignment = { type: "git-remote", branch };
          assignment = next;
          await runInTx((tx) => store.setTaskWorktreeAssignment(tx, taskId, next));
        }
        const identity = await loadIdentity({
          runInTx,
          secretsStore: deps.secretsStore,
          identityName: repo.identityName,
        });
        await pushTaskBranchToRemote({
          localRepoPath: repo.localPath,
          remoteUrl: repo.remoteUrl,
          taskId,
          defaultBranch: repo.defaultBranch,
          identity,
        });
      }
    });

    if (!assignment) {
      throw new Error("allocate-worktree completed without setting worktreeAssignment");
    }
    // Capture in a const so closures below see the non-null type — TS
    // doesn't carry `let` narrowing across closures.
    const wt = assignment;

    // Resolve subscription auth before the durable create-container step
    // so a missing secret short-circuits without spinning up a worktree-
    // bound container that `claude -p` would then hang on. Skipped when
    // the orchestrator is wired without a secrets store (unit tests).
    // Local-capture narrows the type and avoids `secretsStore!`.
    const secretsStore = deps.secretsStore;
    let sandboxEnv: Record<string, string> | undefined;
    if (secretsStore) {
      const authResult = await runInTx((tx) => loadCodingSandboxEnv(tx, secretsStore));
      if (authResult.isErr()) {
        throw new Error(authResult.error.message);
      }
      sandboxEnv = authResult.value;
    }

    // Resolve the GitHub identity once — git-remote backends need it for
    // the sandbox's clone auth. Bind-mount paths skip this entirely.
    let gitRemoteIdentityPat: string | undefined;
    if (sandbox.capabilities.workingTreeTransport === "git-remote") {
      if (!deps.secretsStore) {
        throw new Error("git-remote sandbox requires a secretsStore for clone auth");
      }
      const identity = await loadIdentity({
        runInTx,
        secretsStore: deps.secretsStore,
        identityName: repo.identityName,
      });
      gitRemoteIdentityPat = identity.pat;
    }

    // Three checkpoints for container lifecycle so any failure between
    // sandbox.create() succeeding and the post-create wiring completing
    // still triggers cleanup via the outer catch:
    //
    //   1. `create-container` returns sessionState — once this checkpoints,
    //      the container exists on Docker / Daytona side and is labelled
    //      with the task id.
    //   2. `containerCreated = true` — set OUTSIDE the step body so it
    //      survives Inngest replay (step bodies are skipped on resume,
    //      only checkpointed return values are loaded).
    //   3. `persist-container-id` + `checkout-feature-branch` — wiring
    //      that runs after the flag is set. If either throws, the catch
    //      sees `containerCreated=true` and reaps via deleteByTaskId.
    const sessionState = await stepRun("create-container", async () => {
      const session = await sandbox.create({
        taskId,
        worktree: buildWorktreeSpec({
          taskId,
          capability: sandbox.capabilities.workingTreeTransport,
          assignment: wt,
          remoteUrl: repo.remoteUrl,
          identityPat: gitRemoteIdentityPat,
        }),
        // Managed backends (Daytona) auto-persist sandbox FS across
        // stop/start, so an explicit homeVolume is unnecessary — and the
        // backend doesn't honor it anyway.
        ...(sandbox.capabilities.workingTreeTransport === "bind-mount" && {
          homeVolume: { volumeName: `${HOME_VOLUME_PREFIX}-${taskId}` },
        }),
        image: repo.devcontainer?.image ?? devbaseImage,
        resourceLimits: defaultResourceLimits,
        expiresAt: new Date(Date.now() + taskTtlMs),
        allowPrivilegedRunc: task.allowPrivilegedRunc,
        ...(sandboxEnv && { env: sandboxEnv }),
      });
      return session.state;
    });
    containerCreated = true;

    if (isLocalDockerSessionState(sessionState)) {
      // `containers` is the local-docker FK target; managed backends
      // (Daytona) leave the column null and rely on the sandbox's own
      // task-id label for lineage tracking.
      const containerRowId = sessionState.containerRowId;
      await stepRun("persist-container-id", () =>
        runInTx((tx) => store.setTaskContainerId(tx, taskId, containerRowId)),
      );
    }
    if (sandbox.capabilities.workingTreeTransport === "git-remote") {
      await stepRun("checkout-feature-branch", async () => {
        // Resume a session handle inside the step — handles aren't
        // JSON-serializable so they can't cross step boundaries.
        const session = await sandbox.resume(sessionState);
        await checkoutFeatureBranchInSandbox(session, wt.branch);
      });
    }

    // Re-attach a session handle on this side of the step boundary —
    // handles can't cross step.run because they aren't
    // JSON-serializable, but the state is.
    const container = await sandbox.resume(sessionState);

    // ── Non-durable: stream the plan ──
    planStream = await openPlanStream(taskId);
    // Re-load the task so the prompt template sees the row in its
    // post-allocation state (worktreeAssignment populated, container_id
    // stamped). buildPlanPrompt only reads goal + worktreeAssignment.branch
    // today, so spreading `{...task, worktreeAssignment}` would be enough —
    // but a future prompt change that reads any other lifecycle field
    // (e.g. container metadata) would silently see stale nulls. The
    // single point-read is cheap; the footgun isn't worth saving it.
    const planTask = (await runInTx((tx) => store.getTask(tx, taskId))) ?? task;
    const result = await runPlanStreaming({
      task: planTask,
      repo,
      container,
      backend,
      planStream,
      store,
      runInTx,
    });

    if (result.isError || !result.plan) {
      const reason = result.failureReason ?? "plan phase produced no plan";
      await stepRun("set-status-failed", () =>
        runInTx((tx) =>
          store.updateTaskStatus(tx, { id: taskId, status: "failed", failureReason: reason }),
        ),
      );
      await stepRun("emit-task-failed", () =>
        inngest
          .send({ name: "coding/task/failed", data: { taskId, reason } })
          .then(() => undefined),
      );
      const a = assignment;
      if (a) {
        await stepRun("teardown-worktree", () =>
          safeTeardownWorktree({
            runInTx,
            ...(deps.secretsStore !== undefined && { secretsStore: deps.secretsStore }),
            repo,
            taskId,
            worktreeAssignment: a,
          }),
        );
      }
      await stepRun("teardown", () => sandbox.deleteByTaskId(taskId).catch(() => {}));
      // Stream notification post-commit — wrap so a subscriber error
      // doesn't escape into the outer catch and write a second failed
      // status that masks the original reason.
      await planStream.fail(reason).catch((streamErr: unknown) => {
        log.warn({ err: streamErr, taskId }, "plan stream fail notification failed");
      });
      return { status: "failed", failureReason: reason };
    }

    await stepRun("persist-plan", () =>
      runInTx((tx) => store.setTaskPlan(tx, taskId, result.plan ?? "")),
    );

    // For automated triggers (evolution, signal_pipeline) we'd auto-advance
    // straight to executing. Slice 1 only handles the user trigger path —
    // park at awaiting_approval until the human approves via Telegram.
    const nextStatus: CodingOrchestratorResult["status"] =
      task.triggerSource === "user" ? "awaiting_approval" : "executing";
    await stepRun("set-status-awaiting", () =>
      runInTx((tx) => store.updateTaskStatus(tx, { id: taskId, status: nextStatus })),
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
    // Emit BEFORE the DB status update. If `step.sendEvent` ultimately
    // fails (SDK exhausts its retry budget on a real bus outage), the
    // catch throws, the function fails, and `inngest/function.failed`
    // fires. The `coding-task-reconcile` subscriber sees a still-non-
    // terminal row and re-emits via its own idempotency id. The DB
    // status update reaching this catch first would leave the row
    // terminal and the reconcile would see `already_terminal` and skip.
    // Idempotency `id` dedups against an unlikely repeat fire for the
    // same task.
    await stepSendEvent("emit-task-failed", {
      ...codingTaskFailed.create({ taskId, reason }),
      id: `task-failed-${taskId}`,
    });
    await runInTx((tx) =>
      store.updateTaskStatus(tx, { id: taskId, status: "failed", failureReason: reason }),
    ).catch(() => {});
    if (assignment) {
      await safeTeardownWorktree({
        runInTx,
        ...(deps.secretsStore !== undefined && { secretsStore: deps.secretsStore }),
        repo,
        taskId,
        worktreeAssignment: assignment,
      }).catch(() => {});
    }
    if (containerCreated) {
      await sandbox.deleteByTaskId(taskId).catch(() => {});
    }
    await planStream?.fail(reason).catch(() => {});
    return { status: "failed", failureReason: reason };
  }
}

interface PlanStreamingParams {
  task: CodingTaskRow;
  repo: CodingRepoRow;
  container: SandboxSession;
  backend: CodingBackend;
  planStream: PlanStreamHandle;
  store: CodingStore;
  runInTx: Transactor;
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
  const { task, repo, container, backend, planStream, store, runInTx } = params;
  let plan = "";
  let isError = false;
  let failureReason: string | undefined;

  for await (const event of backend.plan({ task, repo, container })) {
    switch (event.kind) {
      case "session_started":
        await runInTx((tx) => store.setTaskSessionId(tx, task.id, event.sessionId));
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
      return runCodingExecute({
        taskId: event.data.taskId,
        deps,
        stepRun: step.run,
        stepWaitForEvent: step.waitForEvent,
        stepSendEvent: step.sendEvent,
        inngest,
      });
    },
  );
}

/**
 * Build the `WorktreeSpec` the sandbox backend wants. Bind-mount backends
 * get `host-path` pointing at the previously-allocated host worktree;
 * git-remote backends get `cogmo/run/<task-id>` (already pushed to origin
 * by the orchestrator's allocate-worktree step) and HTTPS basic-auth
 * carrying the bot's PAT.
 */
export function buildWorktreeSpec(args: {
  taskId: string;
  capability: "bind-mount" | "git-remote";
  assignment: WorktreeAssignment;
  remoteUrl: string;
  /** Required when `capability === "git-remote"`. */
  identityPat: string | undefined;
}):
  | { type: "host-path"; hostPath: string }
  | {
      type: "git-remote";
      url: string;
      branch: string;
      auth: { username: string; password: string };
    } {
  if (args.capability === "bind-mount") {
    if (args.assignment.type !== "host-path") {
      throw new Error("bind-mount sandbox got non-host-path assignment");
    }
    return { type: "host-path", hostPath: args.assignment.worktreePath };
  }
  if (args.identityPat === undefined) {
    throw new Error("git-remote WorktreeSpec requires identity.pat");
  }
  return {
    type: "git-remote",
    url: args.remoteUrl,
    branch: runBranchFor(args.taskId),
    auth: { username: "x-access-token", password: args.identityPat },
  };
}

/**
 * After cloning `cogmo/run/<task-id>`, move HEAD onto the slice-4 feature
 * branch `cogmo/<idShort>` so `runCommitAndPush(branch)` operates on the
 * right name. Idempotent on retry: `checkout -B` resets the branch to
 * current HEAD if it already exists.
 */
export async function checkoutFeatureBranchInSandbox(
  session: SandboxSession,
  branch: string,
): Promise<void> {
  // See design/coding-delegation.md → Per-callsite exec timeouts.
  // `git checkout -B` is a fast op (~1s in steady state); the caps catch
  // a wedged transport (Daytona WS half-close, hijacked socket stall) and
  // surface as `ExecTimeoutError` on `wait()` so the orchestrator's outer
  // `catch` can mark the task `failed` instead of blocking forever.
  const handle = await session.execStreaming(["git", "checkout", "-B", branch], {
    workingDir: WORKTREE_DIR_IN_CONTAINER,
    timeoutMs: 60_000,
    idleTimeoutMs: 30_000,
  });
  handle.stdout.resume();
  handle.stderr.resume();
  const { exitCode } = await handle.wait();
  if (exitCode !== 0) {
    throw new Error(`git checkout -B ${branch} failed inside sandbox (exit ${exitCode})`);
  }
}

interface ExecuteRunParams {
  taskId: string;
  deps: CodingOrchestratorDeps;
  stepRun: StepRun;
  /**
   * Inngest's `step.waitForEvent` — blocks the durable function until a
   * matching event arrives. Used by the tool gate to wait for the user's
   * Telegram tap on a permission prompt.
   */
  stepWaitForEvent: StepWaitForEvent;
  /**
   * Durable bus emit. Used in the in-worker catch path so a transient
   * send blip surfaces as a function failure (caught by the reconcile
   * subscriber) rather than a silently-swallowed
   * `coding/task/failed` event.
   */
  stepSendEvent: StepSendEvent;
  /**
   * Inngest client — used to emit `coding/task/permission-requested` for
   * observability + Telegram delivery, and any future events the gate
   * fires.
   */
  inngest: Pick<Inngest, "send">;
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
  const { taskId, deps, stepRun, stepWaitForEvent, stepSendEvent, inngest } = params;
  const { runInTx, store, sandbox, backend, devbaseImage, defaultResourceLimits, taskTtlMs } = deps;
  const openExecuteStream = deps.openExecuteStream ?? (async () => NULL_EXECUTE_STREAM);

  const task = await runInTx((tx) => store.getTask(tx, taskId));
  if (!task) throw new Error(`coding task not found: ${taskId}`);
  const repo = await runInTx((tx) => store.getRepoById(tx, task.repoId));
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
      runInTx((tx) => store.transitionTaskStatus(tx, taskId, "awaiting_approval", "executing")),
    );
    if (transition.kind !== "transitioned") {
      log.info(
        { taskId, transition },
        "execute: status transition lost the race (already cancelled or transitioned)",
      );
      return { status: "skipped" };
    }

    const secretsStore = deps.secretsStore;

    // Get-or-create the task container in three checkpoints:
    //
    //   1. `try-resume` — non-null state means a prior sandbox is alive
    //      (the reaper hasn't gotten to it; or the plan-phase container
    //      is still warm). No fresh clone or checkout is needed and we
    //      skip auth resolution entirely.
    //   2. `create-container` (fresh-only) — sandbox.create() returning
    //      sessionState. Auth is resolved INSIDE the body so a resume
    //      hit doesn't pay the DB+decrypt cost, and so the PAT never
    //      becomes a step return value (Inngest persists step returns
    //      and we don't want credentials in its state store).
    //   3. `containerCreated = true` — set OUTSIDE the steps so it
    //      survives Inngest replay. Once any of (1)/(2) checkpointed,
    //      a container labelled with this task id exists and the
    //      catch path's `deleteByTaskId` call reaps it.
    const resumedState = await stepRun("try-resume", async () => {
      const existing = await sandbox.tryResumeByTaskId(taskId);
      return existing?.state ?? null;
    });

    let sessionState: typeof resumedState;
    let isFreshCreate: boolean;
    if (resumedState !== null) {
      sessionState = resumedState;
      isFreshCreate = false;
    } else {
      isFreshCreate = true;
      sessionState = await stepRun("create-container", async () => {
        let sandboxEnv: Record<string, string> | undefined;
        if (secretsStore) {
          const authResult = await runInTx((tx) => loadCodingSandboxEnv(tx, secretsStore));
          if (authResult.isErr()) {
            throw new Error(authResult.error.message);
          }
          sandboxEnv = authResult.value;
        }

        let gitRemoteIdentityPat: string | undefined;
        if (sandbox.capabilities.workingTreeTransport === "git-remote") {
          if (!secretsStore) {
            throw new Error("git-remote sandbox requires a secretsStore for clone auth");
          }
          const identity = await loadIdentity({
            runInTx,
            secretsStore,
            identityName: repo.identityName,
          });
          gitRemoteIdentityPat = identity.pat;
        }

        const session = await sandbox.create({
          taskId,
          worktree: buildWorktreeSpec({
            taskId,
            capability: sandbox.capabilities.workingTreeTransport,
            assignment: worktreeAssignment,
            remoteUrl: repo.remoteUrl,
            identityPat: gitRemoteIdentityPat,
          }),
          ...(sandbox.capabilities.workingTreeTransport === "bind-mount" && {
            homeVolume: { volumeName: `${HOME_VOLUME_PREFIX}-${taskId}` },
          }),
          image: repo.devcontainer?.image ?? devbaseImage,
          resourceLimits: defaultResourceLimits,
          expiresAt: new Date(Date.now() + taskTtlMs),
          allowPrivilegedRunc: task.allowPrivilegedRunc,
          ...(sandboxEnv && { env: sandboxEnv }),
        });
        return session.state;
      });
      // Honest raw telemetry — backend + start timestamp + reserved
      // resources. Captured in its own step.run so the timestamp gets
      // checkpointed (won't get re-stamped on Inngest replay) and so a
      // failure to write doesn't roll back the sandbox creation.
      await stepRun("persist-sandbox-created", () =>
        runInTx((tx) =>
          store.setTaskResourceUsage(tx, taskId, {
            sandbox: {
              backend: sandbox.backendId,
              created_at: new Date().toISOString(),
              provisioned: {
                cpu: defaultResourceLimits.cpus,
                memory_bytes: defaultResourceLimits.memory_bytes,
              },
            },
          }),
        ),
      );
    }
    containerCreated = true;

    // Post-create wiring — only on the fresh-create branch. A resume
    // hit means a prior attempt already ran these (or they're not
    // applicable), so re-running them would either be a no-op or
    // produce confusing logs. Each step is independently checkpointed
    // and individually idempotent (UPDATE setTaskContainerId,
    // `git checkout -B` resets the branch to current HEAD).
    if (isFreshCreate) {
      if (isLocalDockerSessionState(sessionState)) {
        const containerRowId = sessionState.containerRowId;
        await stepRun("persist-container-id", () =>
          runInTx((tx) => store.setTaskContainerId(tx, taskId, containerRowId)),
        );
      }
      if (sandbox.capabilities.workingTreeTransport === "git-remote") {
        await stepRun("checkout-feature-branch", async () => {
          const session = await sandbox.resume(sessionState);
          await checkoutFeatureBranchInSandbox(session, worktreeAssignment.branch);
        });
      }
    }

    const container = await sandbox.resume(sessionState);

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
      runInTx,
      stepWaitForEvent,
      inngest,
    });

    if (result.isError) {
      const reason = result.failureReason ?? "execute phase failed";
      await stepRun("set-status-failed", () =>
        runInTx((tx) =>
          store.updateTaskStatus(tx, { id: taskId, status: "failed", failureReason: reason }),
        ),
      );
      await stepRun("emit-task-failed", () =>
        inngest
          .send({ name: "coding/task/failed", data: { taskId, reason } })
          .then(() => undefined),
      );
      await stepRun("teardown-worktree", () =>
        safeTeardownWorktree({
          runInTx,
          ...(deps.secretsStore !== undefined && { secretsStore: deps.secretsStore }),
          repo,
          taskId,
          worktreeAssignment,
        }),
      );
      await stepRun("teardown", () => sandbox.deleteByTaskId(taskId).catch(() => {}));
      await stepRun("persist-sandbox-deleted", () =>
        runInTx((tx) => store.setTaskSandboxDeletedAt(tx, taskId, new Date().toISOString())),
      );
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
      // Translate the backend's camelCase shape into the snake_case
      // `resource_usage` schema used at the storage layer.
      const usage: Record<string, number> = {};
      if (result.usage.inputTokens != null) usage.tokens_input = result.usage.inputTokens;
      if (result.usage.outputTokens != null) usage.tokens_output = result.usage.outputTokens;
      if (result.usage.costUsd != null) usage.cost_usd = result.usage.costUsd;
      if (Object.keys(usage).length > 0) {
        await stepRun("persist-usage", () =>
          runInTx((tx) => store.setTaskResourceUsage(tx, taskId, usage)),
        );
      }
    }

    await stepRun("set-status-pending-verify", () =>
      runInTx((tx) => store.updateTaskStatus(tx, { id: taskId, status: "pending_verify" })),
    );
    await stepRun("teardown", () => sandbox.deleteByTaskId(taskId).catch(() => {}));
    await stepRun("persist-sandbox-deleted", () =>
      runInTx((tx) => store.setTaskSandboxDeletedAt(tx, taskId, new Date().toISOString())),
    );
    // Hand off to the slice 4.0h verify orchestrator. The dedicated function
    // re-creates a container with the askpass mount, runs verify → push → PR,
    // and tears down on its own. Emitting after the teardown means a concurrent
    // verify run can't reuse this container, which is good — it gets a fresh
    // one with the right secrets bound. `step.run` boundary ensures the event
    // is sent exactly once even if Inngest replays the post-pending-verify path.
    await stepRun("emit-cli-done", () =>
      inngest.send({ name: "coding/task/cli-done", data: { taskId } }).then(() => undefined),
    );
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
    // Emit BEFORE the DB status update — see the rationale on the
    // matching catch in `runCodingTask`.
    await stepSendEvent("emit-task-failed", {
      ...codingTaskFailed.create({ taskId, reason }),
      id: `task-failed-${taskId}`,
    });
    await runInTx((tx) =>
      store.updateTaskStatus(tx, { id: taskId, status: "failed", failureReason: reason }),
    ).catch(() => {});
    await safeTeardownWorktree({
      runInTx,
      ...(deps.secretsStore !== undefined && { secretsStore: deps.secretsStore }),
      repo,
      taskId,
      worktreeAssignment,
    }).catch(() => {});
    if (containerCreated) {
      await sandbox.deleteByTaskId(taskId).catch(() => {});
      // Stamp deleted_at so wall_clock = deleted_at - created_at is
      // computable for tasks that crash mid-execute. The store
      // method's WHERE gate makes this a no-op when no sandbox block
      // was ever persisted (e.g. crash before `persist-sandbox-created`
      // checkpointed) or when deleted_at is already set, so calling
      // unconditionally is safe.
      await runInTx((tx) =>
        store.setTaskSandboxDeletedAt(tx, taskId, new Date().toISOString()),
      ).catch(() => {});
    }
    await executeStream?.fail(reason).catch(() => {});
    return { status: "failed", failureReason: reason };
  }
}

interface ExecuteStreamingParams {
  task: CodingTaskRow;
  repo: CodingRepoRow;
  container: SandboxSession;
  backend: CodingBackend;
  executeStream: ExecuteStreamHandle;
  sessionId: string;
  store: CodingStore;
  runInTx: Transactor;
  stepWaitForEvent: StepWaitForEvent;
  inngest: Pick<Inngest, "send">;
}

interface ExecuteStreamingResult {
  isError: boolean;
  failureReason?: string;
  usage?: BackendUsage;
}

async function runExecuteStreaming(
  params: ExecuteStreamingParams,
): Promise<ExecuteStreamingResult> {
  const {
    task,
    repo,
    container,
    backend,
    executeStream,
    sessionId,
    store,
    runInTx,
    stepWaitForEvent,
    inngest,
  } = params;
  let isError = false;
  let failureReason: string | undefined;
  let usage: BackendUsage | undefined;

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
      case "permission_request": {
        const response = await handlePermissionRequest({
          taskId: task.id,
          requestId: event.requestId,
          tool: event.tool,
          input: (event.input ?? {}) as Record<string, unknown>,
          store,
          runInTx,
          stepWaitForEvent,
          inngest,
        });
        await handle.respondPermission(event.requestId, response);
        break;
      }
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

interface HandlePermissionRequestParams {
  taskId: string;
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
  store: CodingStore;
  runInTx: Transactor;
  stepWaitForEvent: StepWaitForEvent;
  inngest: Pick<Inngest, "send">;
}

/**
 * The tool gate's decision pipeline for a single `permission_request`:
 *
 *   1. Build the canonical pattern (`Bash(git push *)` etc.).
 *   2. Replay the task's decision log — a prior task-scoped `allow` or
 *      `deny` on the matching pattern wins immediately.
 *   3. Run `policy.evaluate` — `allow` short-circuits and logs scope=once
 *      for audit; `prompt` triggers the Telegram round trip.
 *   4. On `prompt`: emit `coding/task/permission-requested` (the Telegram
 *      adapter listens on this and posts the inline keyboard), then
 *      block on `coding/task/permission-decision` until the user taps.
 *      Apply the user's `(decision, scope)` to the log and return.
 *
 * Block-indefinitely on Telegram outage is the design choice (slice3-plan
 * decision 4); the timeout below is a 7-day safety net for truly
 * abandoned tasks, not a deny-on-timeout.
 *
 * **Replay safety.** The decision-log lookup + policy evaluation +
 * persistDecision sequence runs OUTSIDE `step.run`. That's only safe
 * because `createCodingExecuteOrchestrator` pins `retries: 0` — if
 * retries are ever turned on, the task-scoped `insertToolDecision` here
 * would re-fire on replay and produce duplicate rows. Anyone enabling
 * retries needs to wrap this block in `stepRun("evaluate-tool-gate", …)`
 * first.
 */
async function handlePermissionRequest(
  params: HandlePermissionRequestParams,
): Promise<PermissionResponse> {
  const { taskId, requestId, tool, input, store, runInTx, stepWaitForEvent, inngest } = params;
  const call = { tool, input };
  const pattern = canonicalPattern(call);

  // 1. Decision log replay — task-scoped patterns the user already approved.
  const logRows = await runInTx((tx) => store.listToolDecisionsForTask(tx, taskId));
  const replayed = replayDecisionLog(call, logRows);
  if (replayed) {
    log.info(
      { taskId, requestId, tool, pattern, decision: replayed.decision },
      "tool gate: decision-log match",
    );
    return replayed.decision === "allow" ? { behavior: "allow" } : { behavior: "deny" };
  }

  // 2. Static policy.
  const result = policy.evaluate(call);
  if (result.decision === "allow") {
    log.info(
      { taskId, requestId, tool, pattern, reason: result.reason },
      "tool gate: policy allow",
    );
    await persistDecision(store, runInTx, taskId, tool, pattern, "allow", "once");
    return { behavior: "allow" };
  }
  if (result.decision === "deny") {
    log.info({ taskId, requestId, tool, pattern, reason: result.reason }, "tool gate: policy deny");
    await persistDecision(store, runInTx, taskId, tool, pattern, "deny", "once");
    return { behavior: "deny", message: result.reason };
  }

  // 3. Prompt path — emit the request event, wait for the user's tap.
  const requestIdShort = shortenRequestId(requestId);
  await inngest.send({
    name: codingTaskPermissionRequested.name,
    data: { taskId, requestId: requestIdShort, tool },
  });
  log.info(
    { taskId, requestId, requestIdShort, tool, pattern },
    "tool gate: prompting user via Telegram",
  );

  // step.waitForEvent is durable. The `if:` filter pins the wait to this
  // task + this request id, so a concurrent prompt for a different
  // request can't satisfy our wait. 7d timeout is the abandoned-task
  // safety net — design intent is block-indefinitely (slice3-plan #4).
  const decisionEvent = await stepWaitForEvent(`tool-gate-${requestIdShort}`, {
    event: codingTaskPermissionDecision.name,
    if: `async.data.taskId == "${taskId}" && async.data.requestId == "${requestIdShort}"`,
    timeout: "7d",
  });
  if (!decisionEvent) {
    log.warn({ taskId, requestId, tool }, "tool gate: prompt timed out (7d) — denying");
    await persistDecision(store, runInTx, taskId, tool, pattern, "deny", "once");
    return { behavior: "deny", message: "permission prompt timed out" };
  }

  const data = decisionEvent.data as { decision: ToolDecision; scope: "once" | "task" };
  // Persist what the user chose. `task` scope means future matching
  // requests in this task auto-apply; `once` is audit-only.
  await persistDecision(store, runInTx, taskId, tool, pattern, data.decision, data.scope);

  log.info(
    { taskId, requestId, tool, pattern, decision: data.decision, scope: data.scope },
    "tool gate: user decision applied",
  );
  return data.decision === "allow"
    ? { behavior: "allow" }
    : { behavior: "deny", message: "user denied" };
}

async function persistDecision(
  store: CodingStore,
  runInTx: Transactor,
  taskId: string,
  tool: string,
  pattern: string,
  decision: ToolDecision,
  scope: "once" | "task",
): Promise<void> {
  try {
    await runInTx((tx) => store.insertToolDecision(tx, { taskId, tool, pattern, decision, scope }));
  } catch (err) {
    log.warn({ err, taskId, pattern, decision, scope }, "tool gate: insertToolDecision failed");
    // `task` scope is behaviour-changing: future matching requests are
    // supposed to auto-apply this decision via decision-log replay. A
    // silently-lost `task`-scoped row would re-prompt every time, which
    // is annoying but not unsafe — except the user already saw the
    // outcome message ("Allowed for task"), so they expect it to stick.
    // Re-throw so the orchestrator's outer catch marks the task failed
    // and the user can re-delegate; loud beats quiet here. `once` is
    // audit-only and safe to drop on the floor.
    if (scope === "task") {
      throw err;
    }
  }
}
