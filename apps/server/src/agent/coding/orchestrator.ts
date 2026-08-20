import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import { codingTaskFailed, codingTaskPlanApproved, codingTaskStart } from "../../inngest/events.js";
import type { StepRun, StepSendEvent } from "../../inngest/index.js";
import { logger } from "../../logger.js";
import { type AskpassMaterials, cleanupAskpass, provisionAskpass } from "../../sandbox/askpass.js";
import {
  isLocalDockerSessionState,
  type SandboxClient,
  type SandboxSession,
} from "../../sandbox/index.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import type { GitHubIdentity } from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { loadCodingSandboxEnv } from "./auth.js";
import type { BackendUsage, CodingBackend } from "./backend.js";
import { commitAuthorFor, runCommitAndPush } from "./commit-push.js";
import { loadIdentity, pushTaskBranchToRemote, runBranchFor } from "./git-as-transport.js";
import type { CodingRepoRow, CodingStore, CodingTaskRow } from "./store/index.js";
import { safeTeardownWorktree } from "./teardown.js";
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
  /**
   * Finalize the plan stream. `autoApproved` propagates the profile's
   * `coding_autoapprove_mode = 'on'` decision to subscribers (the
   * Telegram progress renderer skips the approve/revise/cancel keyboard
   * when set, since the orchestrator will emit `coding/task/plan-approved`
   * unattended in the next step).
   */
  finalize(plan: string, opts?: { autoApproved?: boolean }): Promise<void>;
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
  /**
   * Host root for per-task askpass material. The execute orchestrator
   * provisions an askpass dir before `create-container` when the
   * transport is `git-remote` and runs `runCommitAndPush` from inside
   * the execute sandbox after the streaming phase completes — claude's
   * edits ride to the verify sandbox via the remote, not the orchestrator.
   * Bind-mount transports share the worktree on the host and don't need
   * the execute-side push.
   */
  askpassBaseDir: string;
  /** Open a delivery channel for streaming plan text. Slice 1 default = NULL_PLAN_STREAM. */
  openPlanStream?: (taskId: string) => Promise<PlanStreamHandle>;
  /**
   * Open a delivery channel for execute-phase progress. Default =
   * NULL_EXECUTE_STREAM. Wired to the `CodingStreamingRegistry` in
   * bootstrap (slice 2.0f), consumed by Telegram delivery in 2.0g.
   */
  openExecuteStream?: (taskId: string) => Promise<ExecuteStreamHandle>;
  /**
   * Test-only override for the in-sandbox coding-auth resolver. Threaded
   * from `BootstrapOptions.codingAuthOverride`; production leaves it
   * undefined so missing `claude_code_oauth_token` still fails fast.
   */
  loadCodingSandboxEnv?: typeof loadCodingSandboxEnv;
}

export interface CodingOrchestratorResult {
  /** `skipped` = a duplicate `coding/task/start`; the row was past `queued`. */
  status: "awaiting_approval" | "executing" | "failed" | "skipped";
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
   * silently-swallowed `coding/task/failed` event. Also used by the
   * auto-approve path to emit `coding/task/plan-approved`.
   */
  stepSendEvent: StepSendEvent;
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
  const { taskId, deps, stepRun, stepSendEvent } = params;
  const taskLog = log.child({ taskId });
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

  // Re-entry guard, and the run's first durable act — the same contract the
  // execute and verify orchestrators hold. A duplicate `coding/task/start`
  // finds the row past `queued`, matches no row, and returns before
  // `sandbox.create` mints a second container and `plan-cli` pays for a
  // second claude session. `delegate`'s emit carries a `task-start-<id>`
  // idempotency id that collapses a re-send inside the bus's dedup window;
  // this transition is what holds outside it.
  //
  // Ahead of the try block for the same reason as the verify orchestrator:
  // a run that loses the race must not reach the failure machinery, which
  // would let it mark a task another run owns as `failed`. Branching on the
  // memoized step result (never on a bare-body status read) is what keeps
  // the run's own write to `planning` from short-circuiting the next
  // boundary's re-invocation.
  const claim = await stepRun("set-status-planning", () =>
    runInTx((tx) => store.transitionTaskStatus(tx, taskId, "queued", "planning")),
  );
  if (claim.kind !== "transitioned") {
    taskLog.info(
      { claim },
      "plan: status transition lost the race (already started or terminated)",
    );
    return { status: "skipped" };
  }

  // Worktree assignment may be null on a fresh task — derived from the
  // (DB-generated) task id by the allocate-worktree step below. Local
  // mutable so the rest of the function reads it without re-loading the row.
  // Single null check covers both fields (atomic by Zod schema).
  let assignment = task.worktreeAssignment;
  // Hoisted out of the try block so the catch can call planStream.fail().
  // Stays null until openPlanStream has actually returned a handle.
  let planStream: PlanStreamHandle | null = null;
  // Hoisted so the catch can call cleanupAskpass on plan-phase failure
  // (success leaves the dir alive — execute's finally owns it once the
  // task transitions to executing).
  let askpassProvisioned = false;
  try {
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
          remoteUrl: repo.remoteUrl,
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
    const loadAuth = deps.loadCodingSandboxEnv ?? loadCodingSandboxEnv;
    let sandboxEnv: Record<string, string> | undefined;
    if (secretsStore) {
      const authResult = await runInTx((tx) => loadAuth(tx, secretsStore));
      if (authResult.isErr()) {
        throw new Error(authResult.error.message);
      }
      sandboxEnv = authResult.value;
    }

    // Resolve the GitHub identity once — git-remote backends need it
    // for the sandbox's clone auth AND for the execute-side push step
    // that runs against the same sandbox. Bind-mount paths skip this
    // entirely.
    let gitRemoteIdentityPat: string | undefined;
    let askpassMaterials: AskpassMaterials | undefined;
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

      // Mount askpass on the plan-phase sandbox so an execute resume
      // (no `sandbox.create()` call on that path) still has the push
      // creds. Cleanup: plan's catch on failure; execute's `finally`
      // on success.
      askpassProvisioned = true;
      askpassMaterials = await stepRun("provision-askpass", () =>
        provisionAskpass({ baseDir: deps.askpassBaseDir, rootTaskId: taskId, identity }),
      );
    }

    // Cleanup on failure goes through `sandbox.deleteByTaskId(taskId)`
    // unconditionally in the outer catch — it's contract-bound to be
    // idempotent (label-indexed lookup, empty set is a no-op). Calling
    // it even when `sandbox.create()` threw covers managed backends
    // (Daytona) where provider-side state can outlive a thrown create:
    // the sandbox row reaches `building_snapshot`/`started` server-side
    // and carries the `cogmo.task` label, so the label-index sweep
    // reaps it. Local-Docker's create commits atomically — a thrown
    // create leaves no rows for the sweep to find, also a no-op.
    const containerImage = repo.devcontainer?.image ?? devbaseImage;
    // Snapshot prewarm acts as the delegate-gate: on Daytona, this
    // resolves once the named snapshot is ACTIVE. Boot fires the same
    // call non-blocking, so a steady-state task hits a resolved promise;
    // a task arriving before the warm completes shares the in-flight
    // promise. Local-Docker `ensureImagePresent` is the cheap pull check.
    await stepRun("ensure-image-present", async () => {
      // Pass limits so a task-time first warm (before boot warm
      // completes, or after a failed boot warm) bakes them in.
      await sandbox.ensureImagePresent(containerImage, defaultResourceLimits);
    });
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
        ...(askpassMaterials && { askpass: askpassMaterials }),
        image: containerImage,
        resourceLimits: defaultResourceLimits,
        expiresAt: new Date(Date.now() + taskTtlMs),
        allowPrivilegedRunc: task.allowPrivilegedRunc,
        ...(sandboxEnv && { env: sandboxEnv }),
      });
      return session.state;
    });

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

    planStream = await openPlanStream(taskId);
    // Capture the handle in a const so the step body below sees the
    // non-null type — TS doesn't carry `let` narrowing across closures.
    const stream = planStream;

    // Durable: `backend.plan` is a billable claude session, and unlike
    // execute it has no `--resume`, so a re-invocation replans from
    // scratch and re-renders the whole plan into the user's message. In
    // the bare body that happened once per remaining step boundary. The
    // session-id write and the plan-text pushes both live inside the body:
    // they fire live on the invocation that runs it and are suppressed on
    // every replay. The result is small and JSON-safe (plan text plus an
    // error flag), and it selects disjoint step sets below, so memoizing
    // it also pins the step graph.
    const result = await stepRun("plan-cli", async () => {
      // Re-attach a session handle inside the step — handles can't cross
      // step.run because they aren't JSON-serializable, but the state is.
      const container = await sandbox.resume(sessionState);
      // Re-load the task so the prompt template sees the row in its
      // post-allocation state (worktreeAssignment populated, container_id
      // stamped). buildPlanPrompt only reads goal + worktreeAssignment.branch
      // today, so spreading `{...task, worktreeAssignment}` would be enough —
      // but a future prompt change that reads any other lifecycle field
      // (e.g. container metadata) would silently see stale nulls. The
      // single point-read is cheap; the footgun isn't worth saving it.
      const planTask = (await runInTx((tx) => store.getTask(tx, taskId))) ?? task;
      return runPlanStreaming({
        task: planTask,
        repo,
        container,
        backend,
        planStream: stream,
        store,
        runInTx,
      });
    });

    if (result.isError || !result.plan) {
      const reason = result.failureReason ?? "plan phase produced no plan";
      await stepRun("set-status-failed", () =>
        runInTx((tx) =>
          store.updateTaskStatus(tx, { id: taskId, status: "failed", failureReason: reason }),
        ),
      );
      await stepSendEvent("emit-task-failed", {
        ...codingTaskFailed.create({ taskId, reason }),
        id: `task-failed-${taskId}`,
      });
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
      await stream.fail(reason).catch((streamErr: unknown) => {
        taskLog.warn({ err: streamErr }, "plan stream fail notification failed");
      });
      return { status: "failed", failureReason: reason };
    }

    await stepRun("persist-plan", () =>
      runInTx((tx) => store.setTaskPlan(tx, taskId, result.plan ?? "")),
    );

    // Automated triggers (evolution, signal_pipeline) advance straight to
    // executing. User-triggered tasks park at awaiting_approval until the
    // human approves via Telegram — UNLESS the profile has
    // `coding_autoapprove_mode='on'`, in which case we stamp
    // `plan_approved_at` and emit `coding/task/plan-approved` directly
    // (same code path the Telegram approve callback takes). Null mode
    // (task without conversation — non-user triggers) reads as `off` and
    // never reaches this branch anyway. Wrapped in `stepRun` so a future
    // loosening of `retries: 0` on this function doesn't quietly turn a
    // transient DB blip into a fresh CLI invocation on replay.
    const autoapproveMode =
      task.triggerSource === "user"
        ? ((await stepRun("resolve-autoapprove-mode", () =>
            runInTx((tx) => store.getCodingAutoapproveModeForTask(tx, taskId)),
          )) ?? "off")
        : "off";
    const nextStatus: CodingOrchestratorResult["status"] =
      task.triggerSource === "user" ? "awaiting_approval" : "executing";
    await stepRun("set-status-awaiting", () =>
      runInTx((tx) => store.updateTaskStatus(tx, { id: taskId, status: nextStatus })),
    );
    // Same wrap as the failure-path notification above — once status is
    // committed, a subscriber error must not regress the task to failed.
    // Durable because two more step boundaries follow it on the
    // auto-approve path: in the bare body the finalize would re-render the
    // plan message on each of them.
    const willAutoApprove = task.triggerSource === "user" && autoapproveMode === "on";
    await stepRun("notify-plan-finalized", async () => {
      await stream
        .finalize(result.plan ?? "", { autoApproved: willAutoApprove })
        .catch((streamErr: unknown) => {
          taskLog.warn(
            { err: streamErr },
            `plan stream finalize notification failed (task already ${nextStatus})`,
          );
        });
      return null;
    });
    // Auto-approve: same effect as the Telegram approve callback. Uses
    // `approvePlanIfPending` so the path is atomic with concurrent
    // cancels/manual approvals — if the user managed to tap Cancel in the
    // microseconds between `set-status-awaiting` and this step, the
    // approve becomes a no-op and the task stays cancelled.
    if (willAutoApprove) {
      // Generate `approvedAt` INSIDE the step so the cached return on a
      // future replay carries the original timestamp — otherwise a
      // retry after the DB write but before the emit would persist
      // an `approvedAt` from attempt 1 while emitting one from attempt 2,
      // and downstream consumers see a row/event timestamp mismatch.
      // `retries: 0` makes this defensive today; pinning it here closes
      // the footgun if retries ever loosen.
      const approveResult = await stepRun("auto-approve-plan", async () => {
        const approvedAt = new Date();
        const result = await runInTx((tx) => store.approvePlanIfPending(tx, taskId, approvedAt));
        return { ...result, approvedAt: approvedAt.toISOString() };
      });
      if (approveResult.kind === "approved") {
        await stepSendEvent("emit-plan-approved", {
          ...codingTaskPlanApproved.create({
            taskId,
            approvedAt: approveResult.approvedAt,
          }),
          // Idempotency id follows the same `<verb>-<taskId>` shape as
          // the catch-path `task-failed-<taskId>` emit; ensures bus-level
          // dedup on the off-chance the step fires more than once (e.g. a
          // future retry change). Safe across the task's lifetime because
          // revise cancels the current task and a re-plan issues a fresh
          // `taskId` (commands.ts handles the Revise tap via
          // `cancelTask`); no path re-emits `plan-approved` for the same
          // id. A future in-place re-plan flow would need to pick a new
          // idempotency id.
          id: `plan-approved-${taskId}`,
        });
        taskLog.info("plan auto-approved via profile autoapprove=on");
      } else {
        taskLog.info(
          { kind: approveResult.kind },
          "auto-approve skipped — task no longer awaiting approval",
        );
      }
    }
    return { status: nextStatus, plan: result.plan ?? "" };
  } catch (err) {
    const reason = (err as Error).message;
    taskLog.error({ err }, "coding task failed");
    // Deliberately broad. Every failure this function can hit — a thrown
    // step body re-raised here as a `StepError` once its retries are
    // exhausted included — converts to the same designed channel:
    // `status=failed` with the reason persisted, plus `coding/task/failed`
    // for the cleanup subscribers. There is no failure mode this should
    // let escape unconverted.
    //
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
    // Letting this throw is load-bearing: a DB blip after a successful
    // emit would otherwise return normally to Inngest, suppress
    // `function.failed`, and leave the row non-terminal forever
    // (reconcile only fires on function failure).
    await runInTx((tx) =>
      store.updateTaskStatus(tx, { id: taskId, status: "failed", failureReason: reason }),
    );
    if (assignment) {
      await safeTeardownWorktree({
        runInTx,
        ...(deps.secretsStore !== undefined && { secretsStore: deps.secretsStore }),
        repo,
        taskId,
        worktreeAssignment: assignment,
      }).catch(() => {});
    }
    // Unconditional — see "Cleanup on failure" comment above the
    // `create-container` step. Idempotent at the label-index layer:
    // a sandbox that never made it server-side is a no-op sweep.
    await sandbox.deleteByTaskId(taskId).catch(() => {});
    if (askpassProvisioned) {
      cleanupAskpass({ baseDir: deps.askpassBaseDir, rootTaskId: taskId });
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
      // tool_call / tool_result fall through to the default no-op — the CLI
      // emits an `ExitPlanMode` tool_use as part of plan completion, but the
      // plan stream surfaces the same text via `text_delta` + `plan_ready`,
      // so the tool_call is redundant noise for the user. permission_request
      // doesn't reach plan mode: the CLI under `--permission-mode plan` (with
      // no `--permission-prompt-tool stdio` flag) resolves every tool call
      // locally and never asks back through the stream-json control channel.
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
 * `claude -p --resume <sid> --permission-mode bypassPermissions` in the
 * same task container (recreating it if the reaper got it first).
 * Sandbox isolation is the security boundary; the CLI resolves every
 * tool call locally with no stdio control channel, and the stream-json
 * output drives the user-visible progress feed.
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
   * Durable bus emit. Used in the in-worker catch path so a transient
   * send blip surfaces as a function failure (caught by the reconcile
   * subscriber) rather than a silently-swallowed
   * `coding/task/failed` event.
   */
  stepSendEvent: StepSendEvent;
  /** Inngest client — used to emit `coding/task/cli-done` after teardown. */
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
  const { taskId, deps, stepRun, stepSendEvent, inngest } = params;
  const taskLog = log.child({ taskId });
  const { runInTx, store, sandbox, backend, devbaseImage, defaultResourceLimits, taskTtlMs } = deps;
  const openExecuteStream = deps.openExecuteStream ?? (async () => NULL_EXECUTE_STREAM);

  const task = await runInTx((tx) => store.getTask(tx, taskId));
  if (!task) throw new Error(`coding task not found: ${taskId}`);
  const repo = await runInTx((tx) => store.getRepoById(tx, task.repoId));
  if (!repo) throw new Error(`coding repo not found: ${task.repoId}`);

  if (!task.planApprovedAt) {
    throw new Error(`coding task ${taskId} has no plan_approved_at — execute fired prematurely`);
  }
  // No bare-body status guard here: `set-status-executing` below writes
  // `executing`, and Inngest re-invokes this body at every step boundary,
  // so a `task.status !== "awaiting_approval"` read at this point would
  // see the run's own write and abandon the rest of the sequence. The
  // conditional UPDATE inside that step is the durable form of the same
  // check — see the guard on `transition.kind`. The three checks that
  // remain read fields the PLAN phase owns and this function never
  // touches, so they are stable across replays.
  if (!task.sessionId) {
    throw new Error(`coding task ${taskId} has no session_id — plan phase didn't capture it`);
  }
  if (!task.worktreeAssignment) {
    throw new Error(`coding task ${taskId} has no worktree_assignment`);
  }

  const sessionId = task.sessionId;
  const worktreeAssignment = task.worktreeAssignment;
  let executeStream: ExecuteStreamHandle | null = null;
  let askpassProvisioned = false;
  // Identity + askpass live together — bundling encodes "both or
  // neither" in the type. Set only when `needsExecutePush`.
  let executePushCtx: { identity: GitHubIdentity; askpass: AskpassMaterials } | undefined;
  const needsExecutePush = sandbox.capabilities.workingTreeTransport === "git-remote";

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
      taskLog.info(
        { transition },
        "execute: status transition lost the race (already cancelled or transitioned)",
      );
      return { status: "skipped" };
    }

    // PAT-bearing identity stays out of `step.run` so it never reaches
    // Inngest's state store. Safe to skip the step boundary only
    // because this function is `retries: 0` — loosen retries and the
    // DB+decrypt would replay; cache through a step then.
    const secretsStore = deps.secretsStore;

    // Get-or-create the task container in two checkpoints:
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
    //
    // Cleanup on failure goes through `sandbox.deleteByTaskId(taskId)`
    // unconditionally in the outer catch — idempotent at the label-index
    // layer, reaps managed-backend state that survived a thrown create.
    const resumedState = await stepRun("try-resume", async () => {
      const existing = await sandbox.tryResumeByTaskId(taskId);
      return existing?.state ?? null;
    });

    // Provision askpass for git-remote unconditionally (resume reuses
    // the plan-phase mount; fresh-create needs it on `sandbox.create`).
    // `askpassProvisioned` flips before the step body so a partial
    // provision still triggers cleanup in `finally`.
    if (needsExecutePush) {
      if (!deps.secretsStore) {
        throw new Error("git-remote sandbox requires a secretsStore for clone + push auth");
      }
      const pushIdentity = await loadIdentity({
        runInTx,
        secretsStore: deps.secretsStore,
        identityName: repo.identityName,
      });
      askpassProvisioned = true;
      const askpass = await stepRun("provision-askpass", async () =>
        provisionAskpass({
          baseDir: deps.askpassBaseDir,
          rootTaskId: taskId,
          identity: pushIdentity,
        }),
      );
      executePushCtx = { identity: pushIdentity, askpass };
    }

    let sessionState: typeof resumedState;
    let isFreshCreate: boolean;
    if (resumedState !== null) {
      sessionState = resumedState;
      isFreshCreate = false;
    } else {
      isFreshCreate = true;
      // Delegate-gate: await the boot-time snapshot warm (Daytona) or
      // image pull check (Local-Docker) before paying the create cost.
      const containerImage = repo.devcontainer?.image ?? devbaseImage;
      await stepRun("ensure-image-present", async () => {
        await sandbox.ensureImagePresent(containerImage, defaultResourceLimits);
      });

      sessionState = await stepRun("create-container", async () => {
        const loadAuth = deps.loadCodingSandboxEnv ?? loadCodingSandboxEnv;
        let sandboxEnv: Record<string, string> | undefined;
        if (secretsStore) {
          const authResult = await runInTx((tx) => loadAuth(tx, secretsStore));
          if (authResult.isErr()) {
            throw new Error(authResult.error.message);
          }
          sandboxEnv = authResult.value;
        }

        const session = await sandbox.create({
          taskId,
          worktree: buildWorktreeSpec({
            taskId,
            capability: sandbox.capabilities.workingTreeTransport,
            assignment: worktreeAssignment,
            remoteUrl: repo.remoteUrl,
            identityPat: executePushCtx?.identity.pat,
          }),
          ...(sandbox.capabilities.workingTreeTransport === "bind-mount" && {
            homeVolume: { volumeName: `${HOME_VOLUME_PREFIX}-${taskId}` },
          }),
          ...(executePushCtx && {
            askpass: {
              hostDir: executePushCtx.askpass.hostDir,
              containerDir: executePushCtx.askpass.containerDir,
            },
          }),
          image: containerImage,
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

    // Const-capture so the closures below see the post-branch non-null
    // type, then resume lazily and at most once per invocation. Handles
    // can't cross a step boundary, `sandbox.resume` is a live provider
    // call, and the bare body runs once per boundary — deferring it to the
    // step bodies that actually need a handle keeps the round-trips
    // proportional to container work rather than to the replay count.
    const state = sessionState;
    let resumed: SandboxSession | null = null;
    const container = async (): Promise<SandboxSession> => {
      resumed ??= await sandbox.resume(state);
      return resumed;
    };

    executeStream = await openExecuteStream(taskId);
    const stream = executeStream;

    // Durable: `backend.execute` is a billable claude session. Left in the
    // bare body it re-ran once per remaining step boundary — a fresh paid
    // CLI invocation and a fresh flood of progress edits each time — and
    // `isError` selects disjoint step sets below, so a verdict that
    // differed between replays would plan a step graph the executor never
    // asked for. The `started` banner and the token/tool pushes fire live
    // from inside the body and are suppressed on replay, which is exactly
    // what the progress UI wants.
    const result = await stepRun("execute-cli", async () => {
      await stream.started?.();
      return runExecuteStreaming({
        task,
        repo,
        container: await container(),
        backend,
        executeStream: stream,
        sessionId,
      });
    });

    if (result.isError) {
      const reason = result.failureReason ?? "execute phase failed";
      await stepRun("set-status-failed", () =>
        runInTx((tx) =>
          store.updateTaskStatus(tx, { id: taskId, status: "failed", failureReason: reason }),
        ),
      );
      await stepSendEvent("emit-task-failed", {
        ...codingTaskFailed.create({ taskId, reason }),
        id: `task-failed-${taskId}`,
      });
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
      await stream.complete(false).catch((streamErr: unknown) => {
        taskLog.warn({ err: streamErr }, "execute stream complete(false) notification failed");
      });
      await stream.fail(reason).catch((streamErr: unknown) => {
        taskLog.warn({ err: streamErr }, "execute stream fail notification failed");
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

    // git-remote transport: push claude's commits to origin from inside
    // the execute sandbox so the verify sandbox (which clones from
    // origin into a fresh tree) sees the same state. Pushed to the
    // run-branch (`cogmo/run/<task-id>`) — the same ref the orchestrator
    // initialized at plan-start and the same ref `buildWorktreeSpec`
    // points the verify sandbox's clone at. Verify then locally creates
    // `cogmo/<idShort>` from the run-branch tip and pushes it to origin
    // as the PR head. Bind-mount transports share the worktree on the
    // host, so the verify-side `runCommitAndPush` covers the same job.
    if (executePushCtx) {
      // The `needsExecutePush` flag is set from the sandbox capability;
      // the worktree assignment is set by the plan orchestrator and
      // should match. Narrow the discriminated union so reading
      // `.branch` is type-safe and a future variant without `branch`
      // would fail here rather than silently typecheck.
      if (worktreeAssignment.type !== "git-remote") {
        throw new Error(
          `git-remote push step requires a git-remote worktree assignment, got ${worktreeAssignment.type}`,
        );
      }
      const pushCtx = executePushCtx;
      const runBranch = runBranchFor(taskId);
      const featureBranch = worktreeAssignment.branch;
      const pushResult = await stepRun("commit-and-push-execute-changes", async () =>
        // `container()` hands back the handle the execute step already
        // resumed when both run in the same invocation, and resumes one
        // on demand when this step body runs alone in a targeted replay.
        runCommitAndPush({
          container: await container(),
          worktreeDir: WORKTREE_DIR_IN_CONTAINER,
          branch: featureBranch,
          remoteBranch: runBranch,
          commitMessage: task.goal,
          signingKeyPath: pushCtx.askpass.signingKeyPath,
          askpassEnv: {
            GIT_ASKPASS: pushCtx.askpass.helperPath,
            GIT_TERMINAL_PROMPT: "0",
          },
          author: commitAuthorFor(pushCtx.identity),
        }),
      );
      if (pushResult.kind !== "pushed" && pushResult.kind !== "nothing_to_commit") {
        const reason = `execute push failed (${pushResult.kind}):\n\n${pushResult.output}`;
        await stepRun("set-status-failed-after-push", () =>
          runInTx((tx) =>
            store.updateTaskStatus(tx, { id: taskId, status: "failed", failureReason: reason }),
          ),
        );
        await stepSendEvent("emit-task-failed", {
          ...codingTaskFailed.create({ taskId, reason }),
          id: `task-failed-${taskId}`,
        });
        // No `teardown-worktree` step here — `safeTeardownWorktree`
        // early-returns for git-remote assignments (no host worktree
        // exists), and `needsExecutePush` only fires for git-remote.
        // Mirrors the verify orchestrator's push-failure path.
        await stepRun("teardown-after-push-failure", () =>
          sandbox.deleteByTaskId(taskId).catch(() => {}),
        );
        await stepRun("persist-sandbox-deleted-after-push-failure", () =>
          runInTx((tx) => store.setTaskSandboxDeletedAt(tx, taskId, new Date().toISOString())),
        );
        await stream.complete(false).catch((streamErr: unknown) => {
          taskLog.warn(
            { err: streamErr },
            "execute stream complete(false) notification failed (push failure)",
          );
        });
        await stream.fail(reason).catch((streamErr: unknown) => {
          taskLog.warn({ err: streamErr }, "execute stream fail notification failed");
        });
        return { status: "failed", failureReason: reason };
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
    await stream.complete(true, completionTokens).catch((streamErr: unknown) => {
      taskLog.warn(
        { err: streamErr },
        "execute stream complete notification failed (task already pending_verify)",
      );
    });
    return { status: "pending_verify" };
  } catch (err) {
    const reason = (err as Error).message;
    taskLog.error({ err }, "coding execute failed");
    // Deliberately broad — same designed failure channel as the matching
    // catch in `runCodingTask`, `StepError` from a permanently-failed step
    // included.
    //
    // Emit BEFORE the DB status update — see the rationale on the
    // matching catch in `runCodingTask`.
    await stepSendEvent("emit-task-failed", {
      ...codingTaskFailed.create({ taskId, reason }),
      id: `task-failed-${taskId}`,
    });
    // Letting this throw is load-bearing — see the matching catch in
    // `runCodingTask`.
    await runInTx((tx) =>
      store.updateTaskStatus(tx, { id: taskId, status: "failed", failureReason: reason }),
    );
    await safeTeardownWorktree({
      runInTx,
      ...(deps.secretsStore !== undefined && { secretsStore: deps.secretsStore }),
      repo,
      taskId,
      worktreeAssignment,
    }).catch(() => {});
    // Unconditional sandbox reap — see the "Cleanup on failure" comment
    // above the try-resume / create-container block. Idempotent.
    await sandbox.deleteByTaskId(taskId).catch(() => {});
    // Stamp deleted_at so wall_clock = deleted_at - created_at is
    // computable for tasks that crash mid-execute. The store method's
    // WHERE gate makes this a no-op when no sandbox block was ever
    // persisted (e.g. crash before `persist-sandbox-created`
    // checkpointed) or when deleted_at is already set.
    await runInTx((tx) =>
      store.setTaskSandboxDeletedAt(tx, taskId, new Date().toISOString()),
    ).catch(() => {});
    await executeStream?.fail(reason).catch(() => {});
    return { status: "failed", failureReason: reason };
  } finally {
    if (askpassProvisioned) {
      cleanupAskpass({ baseDir: deps.askpassBaseDir, rootTaskId: taskId });
    }
  }
}

interface ExecuteStreamingParams {
  task: CodingTaskRow;
  repo: CodingRepoRow;
  container: SandboxSession;
  backend: CodingBackend;
  executeStream: ExecuteStreamHandle;
  sessionId: string;
}

interface ExecuteStreamingResult {
  isError: boolean;
  failureReason?: string;
  usage?: BackendUsage;
}

async function runExecuteStreaming(
  params: ExecuteStreamingParams,
): Promise<ExecuteStreamingResult> {
  const { task, repo, container, backend, executeStream, sessionId } = params;
  let isError = false;
  let failureReason: string | undefined;
  let usage: BackendUsage | undefined;

  for await (const event of backend.execute({ task, repo, container }, sessionId)) {
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
