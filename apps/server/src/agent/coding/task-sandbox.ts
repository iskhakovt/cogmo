/**
 * Task-container wiring shared by the plan, execute and verify
 * orchestrators: the worktree spec a sandbox is created from, and the
 * in-sandbox feature-branch checkout on git-remote backends.
 */

import type { SandboxSession } from "../../sandbox/index.js";
import { runBranchFor } from "./git-as-transport.js";
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
