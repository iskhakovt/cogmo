/**
 * Worktree teardown for failure / cancel cascades, per
 * design/coding-delegation.md → Worktree teardown.
 *
 * The task's clone is bind-mounted read-write into its container, so the
 * sandbox writes all of it, `.git/config` and hooks included. The host
 * therefore runs no git in it: the WIP salvage runs in a salvage container
 * that mounts the tree and the askpass material, and the host only deletes
 * the tree once the salvage reports it safe to.
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

import { existsSync } from "node:fs";
import { match } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import { cleanupAskpass, provisionAskpass } from "../../sandbox/askpass.js";
import type { SandboxClient } from "../../sandbox/index.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import {
  describeResolveIdentityError,
  type GitHubIdentity,
  resolveGitHubIdentity,
} from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { describeError } from "../../util/describe-error.js";
import { runWipSalvage, type WipSalvageResult } from "./commit-push.js";
import type { CodingRepoRow } from "./store/index.js";
import { taskImage, WORKTREE_DIR_IN_CONTAINER } from "./task-sandbox.js";
import type { WorktreeAssignment } from "./types.js";
import { removeWorktree } from "./worktree.js";

const log = logger.child({ component: "coding.teardown" });

/**
 * The salvage container's TTL. The salvage is a handful of git commands and
 * deletes the container itself; this only bounds one a crash left behind,
 * should no later sweep by task id reach it first.
 */
const SALVAGE_TTL_MS = 15 * 60 * 1000;

type SalvageSandbox = Pick<SandboxClient, "ensureImagePresent" | "create" | "deleteByTaskId">;

export interface TeardownWorktreeOpts {
  /** Path to the parent git clone (`coding_repos.local_path`). */
  repoPath: string;
  /** Host filesystem path of the worktree to tear down. */
  worktreePath: string;
  /** Task branch (e.g. `cogmo/abc12345`). */
  branch: string;
  /** Task UUID — the salvage container's lineage label, the WIP commit and ref. */
  taskId: string;
  /**
   * GitHub identity for the WIP push. Without one the salvage container has
   * no askpass: a clean tree is still removed, any other stays on disk.
   */
  identity?: GitHubIdentity;
  sandbox: SalvageSandbox;
  /** The task's image, which has the git the session used. */
  image: string;
  resourceLimits: ResourceLimits;
  /** Host root for per-task askpass material (`SANDBOX_ASKPASS_DIR`). */
  askpassBaseDir: string;
}

export type TeardownResult =
  | { kind: "no_worktree" }
  | { kind: "removed_clean" }
  | { kind: "wip_pushed_and_removed"; wipRef: string; sha: string }
  | { kind: "wip_push_failed_kept"; reason: string }
  /** No container to salvage in, or it died mid-salvage; the host never falls back to git. */
  | { kind: "salvage_unavailable_kept"; reason: string };

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

  const salvaged = await salvageInContainer(opts);
  const result = await match(salvaged)
    .with({ kind: "unavailable" }, async ({ reason }): Promise<TeardownResult> => {
      log.warn({ taskId, worktreePath, reason }, "teardown: no salvage container — keeping");
      return { kind: "salvage_unavailable_kept", reason };
    })
    .with({ kind: "salvaged" }, ({ result: salvage }) => settle(opts, salvage))
    .exhaustive();
  log.info({ taskId, worktreePath, kind: result.kind }, "teardown: done");
  return result;
}

/** Remove the tree when the salvage left nothing behind it; keep it otherwise. */
async function settle(
  opts: TeardownWorktreeOpts,
  salvage: WipSalvageResult,
): Promise<TeardownResult> {
  const { repoPath, worktreePath } = opts;
  return match(salvage)
    .with({ kind: "clean" }, async (): Promise<TeardownResult> => {
      await removeWorktree(repoPath, worktreePath);
      return { kind: "removed_clean" };
    })
    .with({ kind: "pushed" }, async ({ wipRef, sha }): Promise<TeardownResult> => {
      await removeWorktree(repoPath, worktreePath);
      return { kind: "wip_pushed_and_removed", wipRef, sha };
    })
    .with(
      { kind: "no_credentials" },
      async (): Promise<TeardownResult> => ({
        kind: "wip_push_failed_kept",
        reason: "no GitHub identity available for WIP push",
      }),
    )
    .with(
      { kind: "failed" },
      async ({ stage, output }): Promise<TeardownResult> => ({
        kind: "wip_push_failed_kept",
        reason: `git ${stage} failed: ${output}`,
      }),
    )
    .exhaustive();
}

type SalvageOutcome =
  | { kind: "salvaged"; result: WipSalvageResult }
  | { kind: "unavailable"; reason: string };

/**
 * Reap the task's own containers, then run the salvage in a fresh one that
 * mounts the tree and, with an identity, the askpass material. The fresh
 * container is reaped, and the askpass dir removed, before this returns.
 */
async function salvageInContainer(opts: TeardownWorktreeOpts): Promise<SalvageOutcome> {
  const { sandbox, taskId, identity, askpassBaseDir } = opts;
  try {
    await sandbox.deleteByTaskId(taskId);
    const askpass =
      identity === undefined
        ? undefined
        : provisionAskpass({ baseDir: askpassBaseDir, rootTaskId: taskId, identity });
    await sandbox.ensureImagePresent(opts.image);
    const session = await sandbox.create({
      taskId,
      image: opts.image,
      resourceLimits: opts.resourceLimits,
      expiresAt: new Date(Date.now() + SALVAGE_TTL_MS),
      worktree: { type: "host-path", hostPath: opts.worktreePath },
      ...(askpass && {
        askpass: { hostDir: askpass.hostDir, containerDir: askpass.containerDir },
      }),
    });
    const result = await runWipSalvage({
      container: session,
      worktreeDir: WORKTREE_DIR_IN_CONTAINER,
      branch: opts.branch,
      taskId,
      askpassEnv: askpass?.env,
    });
    return { kind: "salvaged", result };
  } catch (err) {
    // A rejection from the sandbox client or an exec: the container could
    // not be had or did not survive. The tree is untouched by the host.
    return { kind: "unavailable", reason: describeError(err) };
  } finally {
    await sandbox.deleteByTaskId(taskId).catch((err: unknown) => {
      log.warn({ err, taskId }, "teardown: salvage container delete failed — left to the reaper");
    });
    cleanupAskpass({ baseDir: askpassBaseDir, rootTaskId: taskId });
  }
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
}

/**
 * Best-effort wrapper around {@link teardownWorktree} for failure / cancel
 * cascades. Loads the GitHub identity for the WIP push; on resolve failure,
 * proceeds without one, so a tree with work in it stays on disk.
 *
 * Never throws — teardown is cleanup, not the operation that failed.
 */
export async function safeTeardownWorktree(
  deps: TeardownDeps,
  args: { repo: CodingRepoRow; taskId: string; worktreeAssignment: WorktreeAssignment },
): Promise<void> {
  const { repo, taskId, worktreeAssignment: assignment } = args;
  if (assignment.type !== "host-path") {
    // git-remote assignments have no host worktree to tear down — the
    // sandbox owns the only checkout, and the run-branch on origin is
    // garbage-collected by the orphan-run-branch cron.
    log.info(
      { taskId, type: assignment.type },
      "teardown-worktree: no host worktree for transport — skipping",
    );
    return;
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
    await teardownWorktree({
      repoPath: repo.localPath,
      worktreePath: assignment.worktreePath,
      branch: assignment.branch,
      taskId,
      ...(resolved.isOk() && { identity: resolved.value }),
      sandbox: deps.sandbox,
      image: taskImage(repo, deps.devbaseImage),
      resourceLimits: deps.defaultResourceLimits,
      askpassBaseDir: deps.askpassBaseDir,
    });
  } catch (err) {
    log.warn({ err, taskId }, "teardown-worktree threw — ignoring");
  }
}
