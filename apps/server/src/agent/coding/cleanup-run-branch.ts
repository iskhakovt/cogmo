/**
 * Event-driven cleanup of `cogmo/run/<task-id>` refs on the GitHub remote.
 *
 * The orchestrator force-pushes a per-task run-branch in `allocate-worktree`
 * so the managed sandbox can clone it, and execute pushes Claude's commits
 * to it. `coding/task/pr-opened` deletes it: the PR head `cogmo/<idShort>`
 * carries the work. `coding/task/failed` keeps it: on git-remote it is the
 * only copy of a failed task's work, and the weekly sweep
 * (`cleanup-orphan-run-branches.ts`) deletes it once its retention passes.
 * The sweep is also the safety net for a `pr-opened` whose delete never ran.
 * See design/coding-delegation.md → Failed-run branch retention.
 */

import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";
import type { Inngest } from "inngest";
import { match, P } from "ts-pattern";
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
 * What a cleanup run did. `kept`: the trigger was `coding/task/failed`, so
 * the branch stays. `not_found`: nothing to delete — the task or repo row is
 * gone, or GitHub answered 404 / 422 (already deleted). `unavailable`: the
 * remote URL does not parse or the identity does not resolve, so the delete
 * waits for the weekly sweep.
 */
export type RunBranchCleanup =
  | { kind: "kept" }
  | { kind: "deleted" }
  | { kind: "not_found"; missing: "task" | "repo" | "ref" }
  | { kind: "unavailable"; detail: string };

/**
 * Delete `cogmo/run/<task-id>` from the repo's remote. Idempotent: 404 and
 * 422 ("Reference does not exist") read as `not_found`. 409 (protected
 * branch) and other statuses propagate so Inngest retries handle transient
 * failures.
 */
export async function deleteRunBranch(
  deps: CleanupRunBranchDeps,
  args: { taskId: string },
): Promise<RunBranchCleanup> {
  const task = await deps.runInTx((tx) => deps.store.getTask(tx, args.taskId));
  if (!task) return { kind: "not_found", missing: "task" };
  const repo = await deps.runInTx((tx) => deps.store.getRepoById(tx, task.repoId));
  if (!repo) return { kind: "not_found", missing: "repo" };

  const remote = parseRemoteUrl(repo.remoteUrl);
  if (!remote) return { kind: "unavailable", detail: `cannot parse remote: ${repo.remoteUrl}` };

  const identityResult = await deps.runInTx((tx) =>
    resolveGitHubIdentity(tx, deps.secretsStore, repo.identityName),
  );
  if (identityResult.isErr()) {
    return { kind: "unavailable", detail: describeResolveIdentityError(identityResult.error) };
  }
  const identity = identityResult.value;

  const octokit = deps.octokitFactory?.(identity.pat) ?? new Octokit({ auth: identity.pat });
  const ref = `heads/${runBranchFor(args.taskId)}`;

  try {
    await octokit.git.deleteRef({ owner: remote.owner, repo: remote.repo, ref });
    log.info({ taskId: args.taskId, ref, repo: repo.name }, "deleted run-branch");
    return { kind: "deleted" };
  } catch (err) {
    if (err instanceof RequestError && (err.status === 404 || err.status === 422)) {
      log.info({ taskId: args.taskId, ref, status: err.status }, "run-branch already gone");
      return { kind: "not_found", missing: "ref" };
    }
    throw err;
  }
}

/**
 * Inngest function on both terminal events, deciding on the triggering
 * event's name — durable for the run, so a run triggered before this rule
 * reads it too. Default retries (3) so a transient GitHub 5xx or secondary
 * rate-limit gets retried with backoff before giving up; the weekly cron
 * sweeps anything that ultimately failed.
 */
export function createRunBranchCleanupSubscriber(deps: CleanupRunBranchDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "coding-cleanup-run-branch",
      // Inngest dedupes a (function, key) pair: duplicate emits of one event
      // for the same task (the in-run and reconcile `failed` emits) collapse
      // to one run, and the event name keeps a `failed` from swallowing a
      // later `pr-opened` for the same task.
      idempotency: 'event.name + "-" + event.data.taskId',
      triggers: [codingTaskPrOpened, codingTaskFailed],
    },
    // Matched on the payload, not the name: the SDK's event union also
    // carries `inngest/function.invoked`, whose data is either payload.
    async ({ event, step }): Promise<RunBranchCleanup> =>
      await match(event.data)
        .with({ reason: P.string }, ({ taskId }): RunBranchCleanup => {
          log.info({ taskId }, "task failed — run-branch kept for the sweep");
          return { kind: "kept" };
        })
        .with({ prUrl: P.string }, ({ taskId }) =>
          step.run("delete-run-branch", () => deleteRunBranch(deps, { taskId })),
        )
        .exhaustive(),
  );
}
