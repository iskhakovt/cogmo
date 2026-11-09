/**
 * The plan phase's `allocate-worktree` stage: derive the task's branch and
 * working tree, persist the assignment, and materialise it for the sandbox
 * transport in use.
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { match } from "ts-pattern";
import type { SandboxClient } from "../../sandbox/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import {
  type BaseMissing,
  fetchDefaultBranchTip,
  loadIdentity,
  pushTaskBranchToRemote,
} from "./git-as-transport.js";
import type { CodingRepoRow } from "./store/index.js";
import type { TaskFailure, WorktreeAssignment } from "./types.js";
import { allocateWorktree, readHeadSha } from "./worktree.js";

interface AllocateTaskWorktreeDeps extends TaskStoreDeps {
  sandbox: Pick<SandboxClient, "capabilities">;
  secretsStore: SecretsStore;
  /** Host root for per-task git worktrees — `${worktreesDir}/<repo>/<id-short>`. */
  worktreesDir: string;
}

/**
 * How allocation ended: the worktree ready, or a saved base neither the
 * mirror nor the remote holds, which ends the task `push_failed`.
 */
export type AllocateOutcome =
  | { kind: "allocated"; assignment: WorktreeAssignment }
  | { kind: "base_missing"; assignment: WorktreeAssignment; failure: TaskFailure };

/**
 * Idempotent reconcile: an assignment a previous attempt persisted is
 * reused; otherwise one is derived from the task id, with the base read
 * for the transport, and persisted before the branch is cut at that base.
 * `onAssigned` hears it at that moment, so the failure path can tear down a
 * half-materialised worktree even when the step throws.
 *
 * - bind-mount: a standalone host clone on the task branch, cut at the
 *   commit the parent repo's HEAD names. An empty parent names none, so
 *   its assignment carries no base.
 * - git-remote: no host worktree. The remote's default branch is fetched
 *   and its tip force-pushed to `cogmo/run/<task-id>` for the sandbox to
 *   clone; the feature branch is checked out inside the sandbox after
 *   create.
 *
 * A retry cuts at the saved base; an assignment without one cuts at the
 * parent's current HEAD, or the freshly fetched tip, and records none.
 *
 * The step returns `base_missing` for a saved base the mirror and the remote
 * both lack, and `null` otherwise; an older build's void result replays as
 * `null` too. The run reads the assignment from the
 * task row, where the step wrote it. The GitHub identity is loaded inside the
 * body and never returned, so the PAT stays out of Inngest's state store.
 */
export async function allocateTaskWorktree(
  run: CodingRun,
  deps: AllocateTaskWorktreeDeps,
  args: {
    repo: CodingRepoRow;
    persisted: WorktreeAssignment | null;
    onAssigned: (assignment: WorktreeAssignment) => void;
  },
): Promise<AllocateOutcome> {
  const { repo } = args;
  let assignment = args.persisted;
  const assign = async (next: WorktreeAssignment): Promise<WorktreeAssignment> => {
    assignment = next;
    args.onAssigned(next);
    await deps.runInTx((tx) => deps.store.setTaskWorktreeAssignment(tx, run.taskId, next));
    return next;
  };

  const outcome = await run.stepRun("allocate-worktree", async (): Promise<BaseMissing | null> => {
    const branch = taskBranchFor(run.taskId);
    if (deps.sandbox.capabilities.workingTreeTransport === "bind-mount") {
      const hostPath =
        assignment ??
        (await assign(
          await hostPathAssignment(repo, {
            branch,
            worktreePath: worktreePathFor(deps.worktreesDir, repo.name, run.taskId),
          }),
        ));
      if (hostPath.type !== "host-path") {
        throw new Error(
          `bind-mount backend requires host-path worktree assignment, got ${hostPath.type}`,
        );
      }
      await allocateWorktree({
        repoPath: repo.localPath,
        branch: hostPath.branch,
        worktreePath: hostPath.worktreePath,
        remoteUrl: repo.remoteUrl,
        baseSha: hostPath.baseSha ?? null,
      });
      return null;
    }
    const identity = await loadIdentity({
      runInTx: deps.runInTx,
      secretsStore: deps.secretsStore,
      identityName: repo.identityName,
    });
    const remote = {
      localRepoPath: repo.localPath,
      remoteUrl: repo.remoteUrl,
      defaultBranch: repo.defaultBranch,
      identity,
    };
    const baseSha = assignment?.baseSha ?? (await fetchDefaultBranchTip(remote));
    if (assignment === null) await assign({ type: "git-remote", branch, baseSha });
    const pushed = await pushTaskBranchToRemote({ ...remote, taskId: run.taskId, baseSha });
    return pushed.isErr() ? pushed.error : null;
  });

  if (!assignment) {
    throw new Error("allocate-worktree completed without setting worktreeAssignment");
  }
  const allocated = assignment;
  return match(outcome)
    .returnType<AllocateOutcome>()
    .with(null, () => ({ kind: "allocated", assignment: allocated }))
    .with({ kind: "base_missing" }, ({ baseSha }) => ({
      kind: "base_missing",
      assignment: allocated,
      failure: {
        reason: "push_failed",
        detail: `the task's recorded base ${baseSha} is in neither the mirror nor the remote's ${repo.defaultBranch} or run branch`,
      },
    }))
    .exhaustive();
}

/** A fresh host-path assignment, its base the commit the parent's HEAD names. */
async function hostPathAssignment(
  repo: CodingRepoRow,
  at: { branch: string; worktreePath: string },
): Promise<WorktreeAssignment> {
  const baseSha = await readHeadSha(repo.localPath);
  return { type: "host-path", ...at, ...(baseSha !== null && { baseSha }) };
}

/**
 * 12 hex chars: the 48-bit prefix of the UUIDv7, which is its full unix-ms
 * timestamp. Two tasks created in the same millisecond could still collide
 * (~1 in 16 from the next nibble), which single-user concurrency makes
 * effectively impossible.
 */
function idShortFor(taskId: string): string {
  return taskId.replaceAll("-", "").slice(0, 12);
}

function taskBranchFor(taskId: string): string {
  return `cogmo/${idShortFor(taskId)}`;
}

/**
 * `${worktreesDir}/<repo>/<idShort>`, refusing a path outside `worktreesDir`
 * even if `repoName` carries traversal sequences. Repo-name validation in
 * `Transport.repos.add` is the first line; this is the second. Segment-aware:
 * `..foo` is a legal directory name, only `..` and `..<sep>` escape.
 */
function worktreePathFor(worktreesDir: string, repoName: string, taskId: string): string {
  const candidatePath = join(worktreesDir, repoName, idShortFor(taskId));
  const rel = relative(resolve(worktreesDir), resolve(candidatePath));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `worktree path escape: repo.name="${repoName}" produced path outside worktreesDir`,
    );
  }
  return candidatePath;
}
