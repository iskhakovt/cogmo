/**
 * Worktree teardown for failure / cancel cascades, per
 * design/coding-delegation.md → Worktree teardown.
 *
 * The task's clone is bind-mounted read-write into its container, so the
 * sandbox writes all of it, `.git/config` and hooks included. The host
 * therefore runs no git in it. The WIP salvage runs in two salvage
 * containers: the commit in one with no credential, the push in a second
 * with only the PAT mounted, created only when there is something to push.
 * The host deletes the tree once the salvage reports it safe to, and every
 * salvage container is gone.
 *
 * Resume reverses: re-materialize the clone, `git fetch origin
 * refs/cogmo-wip/<id>:wip-<id>` → `git checkout wip-<id>` →
 * `git reset --soft HEAD~1` to unstage the WIP commit and continue
 * editing.
 *
 * The bootstrap "no remote yet" case (the tar fallback in Worktree
 * persistence) never arises for repos registered via `/repo add`, which
 * always have a remote URL.
 */

import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { Result, ResultAsync } from "neverthrow";
import { match } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import { type AskpassMaterials, cleanupAskpass, provisionAskpass } from "../../sandbox/askpass.js";
import type { SandboxClient, SandboxSession } from "../../sandbox/index.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import {
  describeResolveIdentityError,
  type GitHubIdentity,
  resolveGitHubIdentity,
} from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { describeError } from "../../util/describe-error.js";
import { runWipCommit, runWipPush, type WipCommitResult } from "./commit-push.js";
import type { CodingRepoRow } from "./store/index.js";
import { taskImage, WORKTREE_DIR_IN_CONTAINER } from "./task-sandbox.js";
import type { WorktreeAssignment } from "./types.js";
import { removeWorktree } from "./worktree.js";

const log = logger.child({ component: "coding.teardown" });

/**
 * A salvage container's TTL. The salvage is a handful of git commands and
 * deletes the container itself; this only bounds one a crash left behind,
 * should no later sweep by task id reach it first.
 */
const SALVAGE_TTL_MS = 15 * 60 * 1000;

/** The push stage's scratch bare repo, inside the push container and outside the tree. */
const SCRATCH_GIT_DIR = "/tmp/cogmo-wip.git";

type SalvageSandbox = Pick<SandboxClient, "ensureImagePresent" | "create" | "deleteByTaskId">;

export interface TeardownWorktreeOpts {
  /** Path to the parent git clone (`coding_repos.local_path`). */
  repoPath: string;
  /** `coding_repos.remote_url`, the WIP push's target. */
  remoteUrl: string;
  /** Host filesystem path of the worktree to tear down. */
  worktreePath: string;
  /** Task UUID — the salvage containers' lineage label, the WIP commit and ref. */
  taskId: string;
  /**
   * GitHub identity for the WIP push. Without one no push container is
   * created: a clean tree is still removed, any other stays on disk.
   */
  identity?: GitHubIdentity;
  sandbox: SalvageSandbox;
  /** The task's image, which has the git the session used. */
  image: string;
  resourceLimits: ResourceLimits;
  /** Host root for per-task askpass material (`SANDBOX_ASKPASS_DIR`). */
  askpassBaseDir: string;
  /** The push stage's scratch bare repo, a path in the push container outside the tree. */
  scratchGitDir: string;
}

export type TeardownResult =
  | { kind: "no_worktree" }
  | { kind: "removed_clean" }
  | { kind: "wip_pushed_and_removed"; wipRef: string; sha: string }
  | { kind: "wip_push_failed_kept"; reason: string }
  /** No container to salvage in, or it died mid-salvage; the host never falls back to git. */
  | { kind: "salvage_unavailable_kept"; reason: string }
  /** A salvage container could not be reaped and may still have the tree mounted. */
  | { kind: "salvage_reap_failed_kept"; reason: string };

/**
 * Tear down a worktree on a failure / cancel path. Never throws. Idempotent:
 * re-running after a removal returns `no_worktree`, and a re-run after a
 * push lands the same commit on the same per-task ref.
 */
export async function teardownWorktree(opts: TeardownWorktreeOpts): Promise<TeardownResult> {
  const { repoPath, worktreePath, taskId } = opts;
  if (!existsSync(worktreePath)) {
    // The parent repo can still hold a stale linked-worktree registration for
    // the path; `removeWorktree` prunes it so a later allocation isn't
    // blocked by "already registered".
    await removeWorktree(repoPath, worktreePath);
    return { kind: "no_worktree" };
  }
  const result = await salvage(opts);
  log.info({ taskId, worktreePath, result }, "teardown: done");
  return result;
}

/**
 * Reap the task's own containers first, so no process the session left
 * running shares the tree or outlives into the push, then commit.
 */
async function salvage(opts: TeardownWorktreeOpts): Promise<TeardownResult> {
  const ready = await reap(opts).andThen(() =>
    ResultAsync.fromPromise(opts.sandbox.ensureImagePresent(opts.image), describeError),
  );
  if (ready.isErr()) return { kind: "salvage_unavailable_kept", reason: ready.error };
  const committed = await inSalvageContainer(opts, undefined, (session) =>
    runWipCommit({
      container: session,
      worktreeDir: WORKTREE_DIR_IN_CONTAINER,
      taskId: opts.taskId,
    }),
  );
  return match(committed)
    .with({ kind: "unavailable" }, unavailableKept)
    .with({ kind: "reap_failed" }, reapFailedKept)
    .with({ kind: "ran" }, ({ value }) => afterCommit(opts, value))
    .exhaustive();
}

async function afterCommit(
  opts: TeardownWorktreeOpts,
  commit: WipCommitResult,
): Promise<TeardownResult> {
  return match(commit)
    .with({ kind: "clean" }, async (): Promise<TeardownResult> => {
      await removeWorktree(opts.repoPath, opts.worktreePath);
      return { kind: "removed_clean" };
    })
    .with(
      { kind: "failed" },
      async ({ stage, output }): Promise<TeardownResult> => ({
        kind: "wip_push_failed_kept",
        reason: `git ${stage} failed: ${output}`,
      }),
    )
    .with({ kind: "needs_push" }, ({ sha }) => push(opts, sha))
    .exhaustive();
}

/** The second container, created only now: the one that holds the PAT. */
async function push(opts: TeardownWorktreeOpts, sha: string): Promise<TeardownResult> {
  const { identity, askpassBaseDir, taskId } = opts;
  if (identity === undefined) {
    return { kind: "wip_push_failed_kept", reason: "no GitHub identity available for WIP push" };
  }
  try {
    // Fails only on the askpass dir's filesystem writes: a full or read-only disk.
    const provisioned = Result.fromThrowable(provisionPushAskpass, describeError)(
      askpassBaseDir,
      taskId,
      identity,
    );
    if (provisioned.isErr()) return { kind: "salvage_unavailable_kept", reason: provisioned.error };
    const askpass = provisioned.value;
    const pushed = await inSalvageContainer(opts, askpass, (session) =>
      runWipPush({
        container: session,
        worktreeDir: WORKTREE_DIR_IN_CONTAINER,
        scratchGitDir: opts.scratchGitDir,
        remoteUrl: opts.remoteUrl,
        taskId,
        sha,
        askpassEnv: askpass.env,
      }),
    );
    return await match(pushed)
      .with({ kind: "unavailable" }, unavailableKept)
      .with({ kind: "reap_failed" }, reapFailedKept)
      .with({ kind: "ran", value: { kind: "failed" } }, async ({ value }) => ({
        kind: "wip_push_failed_kept" as const,
        reason: `git ${value.stage} failed: ${value.output}`,
      }))
      .with({ kind: "ran", value: { kind: "pushed" } }, async ({ value }) => {
        await removeWorktree(opts.repoPath, opts.worktreePath);
        return { kind: "wip_pushed_and_removed" as const, wipRef: value.wipRef, sha: value.sha };
      })
      .exhaustive();
  } finally {
    cleanupAskpass({ baseDir: askpassBaseDir, rootTaskId: taskId });
  }
}

/**
 * The askpass dir with the PAT and its helper only: the WIP commit is
 * unsigned, so the signing key has no business in the container.
 */
function provisionPushAskpass(
  baseDir: string,
  taskId: string,
  identity: GitHubIdentity,
): AskpassMaterials {
  const materials = provisionAskpass({ baseDir, rootTaskId: taskId, identity });
  const signingKey = join(materials.hostDir, basename(materials.signingKeyPath));
  rmSync(signingKey, { force: true });
  rmSync(`${signingKey}.pub`, { force: true });
  return materials;
}

type ContainerRun<T> =
  | { kind: "ran"; value: T }
  /** The create or an exec threw. */
  | { kind: "unavailable"; reason: string }
  /** The run finished, but its container may still be up with the tree mounted. */
  | { kind: "reap_failed"; reason: string };

/**
 * One salvage container: the tree at `/workspace`, `askpass` mounted when
 * given, no home volume, no Claude token. Reaped by task label afterwards,
 * whatever happened; the per-task proxy socket the backend binds into every
 * session it creates comes with it.
 */
async function inSalvageContainer<T>(
  opts: TeardownWorktreeOpts,
  askpass: AskpassMaterials | undefined,
  run: (session: SandboxSession) => Promise<T>,
): Promise<ContainerRun<T>> {
  const ran = await ResultAsync.fromPromise(
    opts.sandbox
      .create({
        taskId: opts.taskId,
        image: opts.image,
        resourceLimits: opts.resourceLimits,
        expiresAt: new Date(Date.now() + SALVAGE_TTL_MS),
        worktree: { type: "host-path", hostPath: opts.worktreePath },
        ...(askpass && {
          askpass: { hostDir: askpass.hostDir, containerDir: askpass.containerDir },
        }),
      })
      .then(run),
    describeError,
  );
  const reaped = await reap(opts);
  if (ran.isErr()) return { kind: "unavailable", reason: ran.error };
  if (reaped.isErr()) return { kind: "reap_failed", reason: reaped.error };
  return { kind: "ran", value: ran.value };
}

function reap(opts: TeardownWorktreeOpts): ResultAsync<void, string> {
  return ResultAsync.fromPromise(opts.sandbox.deleteByTaskId(opts.taskId), describeError).mapErr(
    (reason) => {
      log.warn({ taskId: opts.taskId, reason }, "teardown: reaping the task's containers failed");
      return reason;
    },
  );
}

async function unavailableKept({ reason }: { reason: string }): Promise<TeardownResult> {
  return { kind: "salvage_unavailable_kept", reason };
}

async function reapFailedKept({ reason }: { reason: string }): Promise<TeardownResult> {
  return { kind: "salvage_reap_failed_kept", reason };
}
/** What teardown reads from an orchestrator's deps. */
export interface TeardownDeps {
  /** Identity lookup decrypts a secret, which needs a tx. */
  runInTx: Transactor;
  secretsStore: SecretsStore;
  sandbox: SalvageSandbox;
  devbaseImage: string;
  defaultResourceLimits: ResourceLimits;
  askpassBaseDir: string;
  /**
   * Test-only: where the push stage's scratch repo lives in the push
   * container. Production leaves it unset for `/tmp/cogmo-wip.git`; a test
   * whose "container" is the host points it at a test-owned directory.
   */
  salvageScratchGitDir?: string;
}

/**
 * What a teardown step records: the teardown's own outcome, `no_host_worktree`
 * for a git-remote assignment, or `errored` when loading the identity threw.
 */
export type SafeTeardownResult =
  | TeardownResult
  | { kind: "no_host_worktree" }
  | { kind: "errored"; reason: string };

/**
 * Best-effort wrapper around {@link teardownWorktree} for failure / cancel
 * cascades. Loads the GitHub identity for the WIP push; on resolve failure,
 * proceeds without one, so a tree with work in it stays on disk. Resolves to
 * the outcome, which a teardown step returns as its result.
 *
 * Never throws — teardown is cleanup, not the operation that failed.
 */
export async function safeTeardownWorktree(
  deps: TeardownDeps,
  args: { repo: CodingRepoRow; taskId: string; worktreeAssignment: WorktreeAssignment },
): Promise<SafeTeardownResult> {
  const { repo, taskId, worktreeAssignment: assignment } = args;
  if (assignment.type !== "host-path") {
    // git-remote assignments have no host worktree to tear down — the
    // sandbox owns the only checkout, and the run-branch on origin is
    // garbage-collected by the orphan-run-branch cron.
    log.info(
      { taskId, type: assignment.type },
      "teardown-worktree: no host worktree for transport — skipping",
    );
    return { kind: "no_host_worktree" };
  }
  try {
    // A DB-level failure inside the lookup throws; it stays inside the try
    // so the "never throws" contract holds.
    const resolved = await deps.runInTx((tx) =>
      resolveGitHubIdentity(tx, deps.secretsStore, repo.identityName),
    );
    if (resolved.isErr()) {
      log.warn(
        { taskId, reason: describeResolveIdentityError(resolved.error) },
        "teardown-worktree: identity resolve failed — proceeding without WIP push",
      );
    }
    return await teardownWorktree({
      repoPath: repo.localPath,
      remoteUrl: repo.remoteUrl,
      worktreePath: assignment.worktreePath,
      taskId,
      ...(resolved.isOk() && { identity: resolved.value }),
      sandbox: deps.sandbox,
      image: taskImage(repo, deps.devbaseImage),
      resourceLimits: deps.defaultResourceLimits,
      askpassBaseDir: deps.askpassBaseDir,
      scratchGitDir: deps.salvageScratchGitDir ?? SCRATCH_GIT_DIR,
    });
  } catch (err) {
    log.warn({ err, taskId }, "teardown-worktree threw — ignoring");
    return { kind: "errored", reason: describeError(err) };
  }
}
