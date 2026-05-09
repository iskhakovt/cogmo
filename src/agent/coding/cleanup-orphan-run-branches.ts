/**
 * Weekly safety-net cron for orphan `cogmo/run/*` refs on the GitHub
 * remote. Event-driven cleanup (`cleanup-run-branch.ts`) deletes refs
 * immediately on terminal task events; this cron catches anything that
 * leaked — events that never fired (host crashed between status set and
 * event emit), drift between the DB and the remote, manual pushes, etc.
 *
 * Shape (per Inngest fan-out idiom):
 *   1. Cron fires once a week (`0 4 * * 0` — Sun 04:00 UTC).
 *   2. Lists managed coding repos.
 *   3. Fans out via `step.sendEvent` — one `coding/run-branch-sweep/repo`
 *      event per repo. Each per-repo handler then has its own retries +
 *      step-level observability.
 *   4. Per-repo handler: list `cogmo/run/*` refs via octokit, join with
 *      `coding_tasks`, delete each stale ref via its own `step.run`
 *      (replay-granular, idempotent).
 *
 * Stale criterion: terminal task row OR absent row, AND ref's task is
 * older than 7 days (the retention window — also applies to refs whose
 * task row was deleted, e.g. cancelled tasks GC'd from the DB).
 */

import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";
import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import { codingRunBranchSweepRepo } from "../../inngest/events.js";
import type { StepRun } from "../../inngest/index.js";
import { logger } from "../../logger.js";
import { describeResolveIdentityError, resolveGitHubIdentity } from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { parseRemoteUrl } from "./draft-pr.js";
import { runBranchFor } from "./git-as-transport.js";
import { type CodingStore, isTerminalCodingTaskStatus } from "./store/index.js";

const log = logger.child({ component: "coding.cleanup-orphan-run-branches" });

/** Refs older than this stop being load-bearing for any retry path. */
const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Prefix used by `git.listMatchingRefs` (relative to `refs/`) and by
 * `git.deleteRef` (same convention). The API returns full names of the
 * form `refs/heads/cogmo/run/<task-id>`; both endpoints want the same
 * `heads/cogmo/run/<task-id>` shape on input.
 */
const RUN_BRANCH_REF_PREFIX = "heads/cogmo/run/";

export interface CleanupOrphanRunBranchesDeps {
  runInTx: Transactor;
  store: CodingStore;
  secretsStore: SecretsStore;
  octokitFactory?: (pat: string) => Octokit;
  /** Override for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

export function createOrphanRunBranchSweepFunctions(
  deps: CleanupOrphanRunBranchesDeps,
  inngest: Inngest,
) {
  const cron = inngest.createFunction(
    {
      id: "coding-orphan-run-branch-sweep-cron",
      // 2 retries on the cron's outer body (list-repos, sendEvent fan-
      // out) so a transient DB blip or Inngest event-bus hiccup doesn't
      // lose the entire weekly sweep. Per-repo work has its own retry
      // budget on the perRepo function below; `step.sendEvent`
      // checkpoints, so retries here don't fan out twice.
      retries: 2,
      triggers: [{ cron: "0 4 * * 0" }],
    },
    async ({ step }) => {
      const repos = await step.run("list-repos", () =>
        deps.runInTx((tx) => deps.store.listRepos(tx)),
      );
      if (repos.length === 0) {
        return { repos: 0, fanOut: 0 };
      }
      // Per Inngest fan-out idiom: one event per repo, each with its own
      // retry lane. `step.sendEvent` checkpoints the send, so a cron retry
      // doesn't double-send.
      const events = repos.map((r) => codingRunBranchSweepRepo.create({ repoId: r.id }));
      await step.sendEvent("fan-out", events);
      return { repos: repos.length, fanOut: events.length };
    },
  );

  const perRepo = inngest.createFunction(
    {
      id: "coding-orphan-run-branch-sweep-repo",
      // Per-repo work owns the actual deletes — default retries (3) so a
      // transient octokit 5xx or secondary rate-limit is retried with
      // backoff before giving up. Concurrency capped at 2 so a many-repo
      // fan-out doesn't blow GitHub's per-token budget.
      concurrency: { limit: 2 },
      triggers: [codingRunBranchSweepRepo],
    },
    async ({ event, step }) => {
      return await sweepRepo(deps, event.data.repoId, step.run);
    },
  );

  return [cron, perRepo];
}

/** Exported for unit tests — production callers go through the Inngest function. */
export async function sweepRepo(
  deps: CleanupOrphanRunBranchesDeps,
  repoId: string,
  stepRun: StepRun,
): Promise<{ repoId: string; deleted: number; skipped: number; errors: number }> {
  const now = (deps.now ?? (() => new Date()))();

  const repo = await stepRun("load-repo", () =>
    deps.runInTx((tx) => deps.store.getRepoById(tx, repoId)),
  );
  if (!repo) {
    // Transient race with concurrent repo deletion — not warn-worthy,
    // the cron will skip this fan-out event and pick up survivors next
    // week.
    log.info({ repoId }, "sweep-repo: repo row gone — nothing to do");
    return { repoId, deleted: 0, skipped: 0, errors: 0 };
  }

  const remote = parseRemoteUrl(repo.remoteUrl);
  if (!remote) {
    log.warn({ repoId, remoteUrl: repo.remoteUrl }, "sweep-repo: cannot parse remote");
    return { repoId, deleted: 0, skipped: 0, errors: 0 };
  }

  // Identity contains the PAT + SSH private key — Inngest persists every
  // `step.run` return value into its state store, so loading identity
  // INSIDE `step.run` would leak the bundle. Inline DB read instead;
  // `resolveGitHubIdentity` is idempotent and the cron's only output is
  // the count, not the identity itself.
  const identityResult = await deps.runInTx((tx) =>
    resolveGitHubIdentity(tx, deps.secretsStore, repo.identityName),
  );
  if (identityResult.isErr()) {
    throw new Error(describeResolveIdentityError(identityResult.error));
  }
  const identity = identityResult.value;

  const octokit = deps.octokitFactory?.(identity.pat) ?? new Octokit({ auth: identity.pat });

  // `octokit.paginate` walks all pages — defensive against repos with
  // >30 (or >100) orphan run-branches that would otherwise be partially
  // swept and leak over time. Carry only the task id forward; the full
  // ref shape `heads/cogmo/run/<task-id>` is reconstructed via
  // `runBranchFor` at every consumer site for symmetry with
  // `cleanup-run-branch.ts`.
  const taskIds = await stepRun("list-run-refs", async () => {
    const all = await octokit.paginate(octokit.git.listMatchingRefs, {
      owner: remote.owner,
      repo: remote.repo,
      ref: RUN_BRANCH_REF_PREFIX,
      per_page: 100,
    });
    return all.map((r) => r.ref.replace(/^refs\/heads\/cogmo\/run\//, ""));
  });

  if (taskIds.length === 0) {
    return { repoId, deleted: 0, skipped: 0, errors: 0 };
  }

  // Batch task lookup — one query for every ref. Avoids N round-trips
  // through Inngest's executor and stays well under any per-function
  // step-count cap. Map by id for O(1) lookup in the loop below.
  const tasks = await stepRun("load-tasks", () =>
    deps.runInTx((tx) => deps.store.getTasksByIds(tx, taskIds)),
  );
  const tasksById = new Map(tasks.map((t) => [t.id, t] as const));

  let deleted = 0;
  let skipped = 0;
  let errors = 0;

  for (const taskId of taskIds) {
    const task = tasksById.get(taskId);

    // Stale criterion: task row is terminal AND created >7 days ago, OR
    // there is no task row at all (deleted, or this ref came from a
    // foreign source). Non-terminal tasks are NEVER swept regardless of
    // age — they may be stuck pending approval; the user owns that.
    let stale: boolean;
    if (!task) {
      stale = true;
    } else if (!isTerminalCodingTaskStatus(task.status)) {
      stale = false;
    } else {
      // `stepRun` round-trips through JSON, so `createdAt` arrives as an
      // ISO string. `new Date(string)` parses it back.
      const createdAt = new Date(task.createdAt);
      const ageMs = now.getTime() - createdAt.getTime();
      stale = ageMs >= RETENTION_MS;
    }

    if (!stale) {
      skipped++;
      continue;
    }

    const ref = `heads/${runBranchFor(taskId)}`;
    try {
      await stepRun(`delete-${taskId}`, async () => {
        try {
          await octokit.git.deleteRef({
            owner: remote.owner,
            repo: remote.repo,
            ref,
          });
          log.info({ taskId, ref, repo: repo.name }, "swept orphan run-branch");
        } catch (err) {
          if (err instanceof RequestError && (err.status === 404 || err.status === 422)) {
            log.info({ taskId, ref, status: err.status }, "run-branch already gone");
            return;
          }
          throw err;
        }
      });
      deleted++;
    } catch (err) {
      // The per-delete `step.run` already exhausted its default retry
      // budget before reaching here. Continue to the next ref instead
      // of bubbling up — one bad ref shouldn't block the rest of this
      // week's sweep, and the next weekly tick will pick this one up
      // again. The error count surfaces in the function's return so
      // it shows up in Inngest's run history.
      log.warn({ err, taskId, ref }, "sweep-repo: delete-ref failed after retries — continuing");
      errors++;
    }
  }

  log.info({ repoId, refs: taskIds.length, deleted, skipped, errors }, "sweep-repo done");
  return { repoId, deleted, skipped, errors };
}
