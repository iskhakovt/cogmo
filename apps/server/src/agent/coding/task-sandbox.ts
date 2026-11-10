/**
 * Task-container wiring shared by the plan, execute and verify
 * orchestrators: the spec a task sandbox is created from, re-attaching to
 * it across step boundaries, the in-sandbox feature-branch checkout on
 * git-remote backends, and reaping it.
 */

import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import type {
  AskpassSpec,
  ReadOnlyDirSpec,
  ResumeOptions,
  SandboxClient,
  SandboxSession,
  SandboxSessionState,
  SessionSpec,
} from "../../sandbox/index.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { loadCodingSandboxEnv } from "./auth.js";
import type { CodingRun } from "./coding-run.js";
import { findIdentity, runBranchFor } from "./git-as-transport.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";
import type { TaskFailure, WorktreeAssignment } from "./types.js";

const HOME_VOLUME_PREFIX = "cogmo-task-home";
export const WORKTREE_DIR_IN_CONTAINER = "/workspace";

/** Carries the assignment's `baseSha` to the skills repo's `.cogmo/verify`. */
const VERIFY_BASE_ENV = "COGMO_VERIFY_BASE";

/**
 * What every session of one repo's tasks receives beside the rest: a
 * read-only directory and the env naming it. The composition root passes the
 * skills repo's gates bundle (design/skills.md → The gates in verify →
 * Delivery), so neither the sandbox nor the coding stages know what it holds.
 */
export interface RepoSessionDir {
  /** The `coding_repos.name` whose tasks' sessions receive it. */
  repoName: string;
  readOnlyDir: ReadOnlyDirSpec;
  env: Readonly<Record<string, string>>;
}

/** `dir` when the sessions of `repo`'s tasks receive it. */
function repoDirOf(
  dir: RepoSessionDir | null,
  repo: Pick<CodingRepoRow, "name">,
): RepoSessionDir | null {
  return dir !== null && dir.repoName === repo.name ? dir : null;
}

/**
 * What a re-attach to a session of `repo`'s task passes beside its state: the
 * repo's read-only directory, so a Daytona sandbox an older release created
 * receives the running release's.
 */
export function resumeOptionsFor(
  dir: RepoSessionDir | null,
  repo: Pick<CodingRepoRow, "name">,
): ResumeOptions {
  const own = repoDirOf(dir, repo);
  return own === null ? {} : { readOnlyDir: own.readOnlyDir };
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

/** The env, inside the `create-container` body; a token gone since `check-credentials` is a step error. */
export async function loadSandboxEnvOrThrow(
  deps: SandboxAuthDeps,
): Promise<Readonly<Record<string, string>>> {
  const auth = await loadSandboxEnv(deps);
  if (auth.isErr()) throw new Error(auth.error.message);
  return auth.value;
}

/** What `check-credentials` memoizes: the verdict, never a secret. */
type CredentialsVerdict = { kind: "present" } | { kind: "missing"; message: string };

/**
 * The run's credentials gate, ahead of anything that needs them: the Claude
 * OAuth token when the run will create a container, and the repo's GitHub
 * identity when it will clone or push (`identityName`). A miss is the task's
 * `credentials_unavailable` failure. Memoized, so a secret changed later in
 * the run does not change which steps it plans. With nothing to check (a
 * bind-mount resume) there is no step.
 */
export async function checkTaskCredentials(
  run: CodingRun,
  deps: SandboxAuthDeps,
  args: { token: boolean; identityName: string | null },
): Promise<Result<void, TaskFailure>> {
  const { token, identityName } = args;
  if (!token && identityName === null) return ok(undefined);
  const verdict = await run.stepRun("check-credentials", async (): Promise<CredentialsVerdict> => {
    if (token) {
      const auth = await loadSandboxEnv(deps);
      if (auth.isErr()) return { kind: "missing", message: auth.error.message };
    }
    if (identityName !== null) {
      const identity = await findIdentity({
        runInTx: deps.runInTx,
        secretsStore: deps.secretsStore,
        identityName,
      });
      if (identity.isErr()) return { kind: "missing", message: identity.error };
    }
    return { kind: "present" };
  });
  return match(verdict)
    .with({ kind: "present" }, () => ok<void, TaskFailure>(undefined))
    .with({ kind: "missing" }, ({ message }) =>
      err<void, TaskFailure>({ reason: "credentials_unavailable", detail: message }),
    )
    .exhaustive();
}

/** The repo's devcontainer image, else the default base image. */
export function taskImage(repo: CodingRepoRow, devbaseImage: string): string {
  return repo.devcontainer?.image ?? devbaseImage;
}

/**
 * The `sandbox.create` spec for a task container. Call it inside the
 * `create-container` step body: `expiresAt` is stamped from the clock, and
 * the PAT inside the worktree spec must never reach a step's return value.
 * Its env adds `COGMO_VERIFY_BASE` when the assignment has a base; every exec
 * in the session inherits it, as the Claude token does. A task on `repoDir`'s
 * repo also gets its read-only directory, and its env.
 */
export function taskSessionSpec(args: {
  sandbox: Pick<SandboxClient, "capabilities">;
  task: Pick<CodingTaskRow, "id" | "allowPrivilegedRunc">;
  repo: CodingRepoRow;
  assignment: WorktreeAssignment;
  identityPat: string | undefined;
  askpass: AskpassSpec | undefined;
  repoDir: RepoSessionDir | null;
  image: string;
  resourceLimits: ResourceLimits;
  taskTtlMs: number;
  env: Readonly<Record<string, string>>;
}): SessionSpec {
  const transport = args.sandbox.capabilities.workingTreeTransport;
  const repoDir = repoDirOf(args.repoDir, args.repo);
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
    ...(repoDir && { readOnlyDir: repoDir.readOnlyDir }),
    image: args.image,
    resourceLimits: args.resourceLimits,
    expiresAt: new Date(Date.now() + args.taskTtlMs),
    allowPrivilegedRunc: args.task.allowPrivilegedRunc,
    env: {
      ...args.env,
      ...(args.assignment.baseSha !== undefined && {
        [VERIFY_BASE_ENV]: args.assignment.baseSha,
      }),
      ...repoDir?.env,
    },
    // The coding CLI reaches its provider, the git remote and package indexes.
    network: "bridge",
  };
}

/**
 * Re-attaches to the task sandbox lazily, at most once per invocation:
 * handles can't cross a step boundary, and `sandbox.resume` is a live
 * provider call, so the round-trips scale with container work rather than
 * with replay count. Memoizes the promise, not the resolved handle — two
 * concurrent callers would otherwise both see null and both resume. `opts`
 * goes to the resume (`resumeOptionsFor`).
 */
export function lazySession(
  sandbox: Pick<SandboxClient, "resume">,
  state: SandboxSessionState,
  opts: ResumeOptions,
): () => Promise<SandboxSession> {
  let resumed: Promise<SandboxSession> | null = null;
  return () => {
    resumed ??= sandbox.resume(state, opts);
    return resumed;
  };
}

/**
 * The `checkout-feature-branch` step, git-remote only: the sandbox cloned
 * `cogmo/run/<task-id>`, and commit-and-push works on `branch`. `resume`
 * goes to the resume (`resumeOptionsFor`).
 */
export async function checkoutFeatureBranchStep(
  run: CodingRun,
  sandbox: Pick<SandboxClient, "resume">,
  state: SandboxSessionState,
  args: { branch: string; resume: ResumeOptions },
): Promise<void> {
  await run.stepRun("checkout-feature-branch", async () => {
    const session = await sandbox.resume(state, args.resume);
    await checkoutFeatureBranchInSandbox(session, args.branch);
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
 * After cloning `cogmo/run/<task-id>`, move HEAD onto the task's feature
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
