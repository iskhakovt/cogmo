/**
 * Task-container wiring shared by the plan, execute and verify
 * orchestrators: the spec a task sandbox is created from, re-attaching to
 * it across step boundaries, the in-sandbox feature-branch checkout on
 * git-remote backends, and reaping it.
 */

import type { Transactor } from "../../db/index.js";
import type {
  AskpassSpec,
  SandboxClient,
  SandboxSession,
  SandboxSessionState,
  SessionSpec,
} from "../../sandbox/index.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { loadCodingSandboxEnv } from "./auth.js";
import type { CodingRun } from "./coding-run.js";
import { runBranchFor } from "./git-as-transport.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";
import type { WorktreeAssignment } from "./types.js";

export const HOME_VOLUME_PREFIX = "cogmo-task-home";
export const WORKTREE_DIR_IN_CONTAINER = "/workspace";

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

export interface SandboxAuthDeps {
  runInTx: Transactor;
  secretsStore: SecretsStore;
  /**
   * Test-only override for the in-sandbox coding-auth resolver. Threaded
   * from `BootstrapOptions.codingAuthOverride`; production leaves it
   * undefined so a missing `claude_code_oauth_token` still fails fast.
   */
  loadCodingSandboxEnv?: typeof loadCodingSandboxEnv;
}

/** The Claude Code subscription env the task container is created with. */
export function loadSandboxEnv(deps: SandboxAuthDeps): ReturnType<typeof loadCodingSandboxEnv> {
  const load = deps.loadCodingSandboxEnv ?? loadCodingSandboxEnv;
  return deps.runInTx((tx) => load(tx, deps.secretsStore));
}

/** The repo's devcontainer image, else the default base image. */
export function taskImage(repo: CodingRepoRow, devbaseImage: string): string {
  return repo.devcontainer?.image ?? devbaseImage;
}

/**
 * The `sandbox.create` spec for a task container. Call it inside the
 * `create-container` step body: `expiresAt` is stamped from the clock, and
 * the PAT inside the worktree spec must never reach a step's return value.
 */
export function taskSessionSpec(args: {
  sandbox: Pick<SandboxClient, "capabilities">;
  task: Pick<CodingTaskRow, "id" | "allowPrivilegedRunc">;
  repo: CodingRepoRow;
  assignment: WorktreeAssignment;
  identityPat: string | undefined;
  askpass: AskpassSpec | undefined;
  image: string;
  resourceLimits: ResourceLimits;
  taskTtlMs: number;
  env: Readonly<Record<string, string>>;
}): SessionSpec {
  const transport = args.sandbox.capabilities.workingTreeTransport;
  return {
    taskId: args.task.id,
    worktree: buildWorktreeSpec({
      taskId: args.task.id,
      capability: transport,
      assignment: args.assignment,
      remoteUrl: args.repo.remoteUrl,
      identityPat: args.identityPat,
    }),
    // Managed backends (Daytona) auto-persist sandbox FS across stop/start,
    // so an explicit homeVolume is unnecessary — and they don't honor it.
    ...(transport === "bind-mount" && {
      homeVolume: { volumeName: `${HOME_VOLUME_PREFIX}-${args.task.id}` },
    }),
    ...(args.askpass && {
      askpass: { hostDir: args.askpass.hostDir, containerDir: args.askpass.containerDir },
    }),
    image: args.image,
    resourceLimits: args.resourceLimits,
    expiresAt: new Date(Date.now() + args.taskTtlMs),
    allowPrivilegedRunc: args.task.allowPrivilegedRunc,
    env: args.env,
  };
}

/**
 * Re-attaches to the task sandbox lazily, at most once per invocation:
 * handles can't cross a step boundary, and `sandbox.resume` is a live
 * provider call, so the round-trips scale with container work rather than
 * with replay count. Memoizes the promise, not the resolved handle — two
 * concurrent callers would otherwise both see null and both resume.
 */
export function lazySession(
  sandbox: Pick<SandboxClient, "resume">,
  state: SandboxSessionState,
): () => Promise<SandboxSession> {
  let resumed: Promise<SandboxSession> | null = null;
  return () => {
    resumed ??= sandbox.resume(state);
    return resumed;
  };
}

/**
 * The `checkout-feature-branch` step, git-remote only: the sandbox cloned
 * `cogmo/run/<task-id>`, and commit-and-push works on `branch`.
 */
export async function checkoutFeatureBranchStep(
  run: CodingRun,
  sandbox: Pick<SandboxClient, "resume">,
  state: SandboxSessionState,
  branch: string,
): Promise<void> {
  await run.stepRun("checkout-feature-branch", async () => {
    const session = await sandbox.resume(state);
    await checkoutFeatureBranchInSandbox(session, branch);
  });
}

/**
 * Reaps every sandbox labelled with the task, as a step. Idempotent at the
 * label-index layer, and it sweeps provider-side state a thrown create left
 * behind on managed backends. Errors are swallowed: the sandbox reaper is
 * the backstop.
 */
export async function reapTaskSandbox(
  run: CodingRun,
  sandbox: Pick<SandboxClient, "deleteByTaskId">,
  stepId: string,
): Promise<void> {
  await run.stepRun(stepId, () => sandbox.deleteByTaskId(run.taskId).catch(() => {}));
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
  // surface as a timed_out `ExecError` on `wait()` so the orchestrator's outer
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
