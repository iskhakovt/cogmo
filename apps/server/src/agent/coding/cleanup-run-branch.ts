/**
 * Event-driven cleanup of `cogmo/run/<task-id>` refs on the GitHub remote.
 *
 * The orchestrator force-pushes a per-task run-branch in `allocate-worktree`
 * so the managed sandbox can clone it. Once the task reaches a terminal
 * state (`pr_open` for success, `failed` for any failure path), the
 * run-branch has served its purpose and is dead weight on the remote.
 *
 * This module subscribes to both terminal events and deletes the ref via
 * `octokit.git.deleteRef`. The weekly cleanup cron (`cleanup-orphan-run-
 * branches.ts`) is the safety net for events that never fired (crash
 * between `set-status-failed` and `emit-task-failed`, network blip, etc.).
 */

import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";
import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import { codingTaskFailed, codingTaskPrOpened } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import { describeResolveIdentityError, resolveGitHubIdentity } from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { runBranchFor } from "./git-as-transport.js";
import { parseRemoteUrl } from "./open-pr.js";
import type { CodingStore } from "./store/index.js";

const log = logger.child({ component: "coding.cleanup-run-branch" });

export interface CleanupRunBranchDeps {
  runInTx: Transactor;
  store: CodingStore;
  secretsStore: SecretsStore;
  /**
   * Optional Octokit factory — tests inject a stub. Production omits it
   * and we construct a real client from the resolved identity's PAT.
   */
  octokitFactory?: (pat: string) => Octokit;
}

/**
 * Delete `cogmo/run/<task-id>` from the repo's remote. Idempotent: 404
 * (already deleted) and 422 ("Reference does not exist") are swallowed —
 * the standard pattern for octokit `git.deleteRef` per the repo's existing
 * convention. 409 (protected branch) and other statuses propagate so
 * Inngest retries handle transient failures.
 */
export async function deleteRunBranch(
  deps: CleanupRunBranchDeps,
  args: { taskId: string },
): Promise<{ deleted: boolean; reason?: string }> {
  const task = await deps.runInTx((tx) => deps.store.getTask(tx, args.taskId));
  if (!task) return { deleted: false, reason: "task row not found" };
  const repo = await deps.runInTx((tx) => deps.store.getRepoById(tx, task.repoId));
  if (!repo) return { deleted: false, reason: "repo row not found" };

  const remote = parseRemoteUrl(repo.remoteUrl);
  if (!remote) return { deleted: false, reason: `cannot parse remote: ${repo.remoteUrl}` };

  const identityResult = await deps.runInTx((tx) =>
    resolveGitHubIdentity(tx, deps.secretsStore, repo.identityName),
  );
  if (identityResult.isErr()) {
    return { deleted: false, reason: describeResolveIdentityError(identityResult.error) };
  }
  const identity = identityResult.value;

  const octokit = deps.octokitFactory?.(identity.pat) ?? new Octokit({ auth: identity.pat });
  const ref = `heads/${runBranchFor(args.taskId)}`;

  try {
    await octokit.git.deleteRef({ owner: remote.owner, repo: remote.repo, ref });
    log.info({ taskId: args.taskId, ref, repo: repo.name }, "deleted run-branch");
    return { deleted: true };
  } catch (err) {
    if (err instanceof RequestError && (err.status === 404 || err.status === 422)) {
      log.info({ taskId: args.taskId, ref, status: err.status }, "run-branch already gone");
      return { deleted: false, reason: `already gone (${err.status})` };
    }
    throw err;
  }
}

/**
 * Inngest function that subscribes to both terminal events and deletes
 * the run-branch. Default retries (3) so a transient GitHub 5xx or
 * secondary rate-limit gets retried with backoff before giving up; the
 * weekly cron sweeps anything that ultimately failed.
 */
export function createRunBranchCleanupSubscriber(deps: CleanupRunBranchDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "coding-cleanup-run-branch",
      // Idempotency on the task id — Inngest dedupes a (function, key)
      // pair so simultaneous fires from both terminal events for the
      // same task collapse to one execution.
      idempotency: "event.data.taskId",
      triggers: [codingTaskPrOpened, codingTaskFailed],
    },
    async ({ event, step }) => {
      const taskId = event.data.taskId;
      return await step.run("delete-run-branch", () => deleteRunBranch(deps, { taskId }));
    },
  );
}
