/**
 * The plan phase's `allocate-worktree` stage: derive the task's branch and
 * working tree, persist the assignment, and materialise it for the sandbox
 * transport in use.
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SandboxClient } from "../../sandbox/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import { loadIdentity, pushTaskBranchToRemote } from "./git-as-transport.js";
import type { CodingRepoRow } from "./store/index.js";
import type { WorktreeAssignment } from "./types.js";
import { allocateWorktree } from "./worktree.js";

interface AllocateTaskWorktreeDeps extends TaskStoreDeps {
  sandbox: Pick<SandboxClient, "capabilities">;
  secretsStore: SecretsStore;
  /** Host root for per-task git worktrees — `${worktreesDir}/<repo>/<id-short>`. */
  worktreesDir: string;
}

/**
 * Idempotent reconcile: an assignment a previous attempt persisted is
 * reused; otherwise one is derived from the task id and persisted before the
 * worktree itself is materialised. `onAssigned` hears it at that moment, so
 * the failure path can tear down a half-materialised worktree even when the
 * step throws.
 *
 * - bind-mount: a standalone host clone on the task branch.
 * - git-remote: no host worktree. The default-branch tip is force-pushed to
 *   `cogmo/run/<task-id>` for the sandbox to clone; the feature branch is
 *   checked out inside the sandbox after create.
 *
 * The GitHub identity is loaded inside the body and never returned, so the
 * PAT stays out of Inngest's state store.
 */
export async function allocateTaskWorktree(
  run: CodingRun,
  deps: AllocateTaskWorktreeDeps,
  args: {
    repo: CodingRepoRow;
    persisted: WorktreeAssignment | null;
    onAssigned: (assignment: WorktreeAssignment) => void;
  },
): Promise<WorktreeAssignment> {
  const { repo } = args;
  let assignment = args.persisted;
  const assign = async (next: WorktreeAssignment): Promise<WorktreeAssignment> => {
    assignment = next;
    args.onAssigned(next);
    await deps.runInTx((tx) => deps.store.setTaskWorktreeAssignment(tx, run.taskId, next));
    return next;
  };

  await run.stepRun("allocate-worktree", async () => {
    const branch = taskBranchFor(run.taskId);
    if (deps.sandbox.capabilities.workingTreeTransport === "bind-mount") {
      const hostPath =
        assignment ??
        (await assign({
          type: "host-path",
          branch,
          worktreePath: worktreePathFor(deps.worktreesDir, repo.name, run.taskId),
        }));
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
      });
      return;
    }
    if (!assignment) await assign({ type: "git-remote", branch });
    const identity = await loadIdentity({
      runInTx: deps.runInTx,
      secretsStore: deps.secretsStore,
      identityName: repo.identityName,
    });
    await pushTaskBranchToRemote({
      localRepoPath: repo.localPath,
      remoteUrl: repo.remoteUrl,
      taskId: run.taskId,
      defaultBranch: repo.defaultBranch,
      identity,
    });
  });

  if (!assignment) {
    throw new Error("allocate-worktree completed without setting worktreeAssignment");
  }
  return assignment;
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
