import type { Inngest } from "inngest";
import { match, P } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import { fromStepTools } from "../inngest/durable.js";
import { logger } from "../logger.js";
import { describeError } from "../util/describe-error.js";
import {
  type MirrorDeps,
  type MirrorPushOutcome,
  mirrorMain,
  readRemoteMain,
  remoteMainIsAncestor,
} from "./deploy/mirror.js";
import { getMainSha } from "./git-ops.js";
import { readOriginUrl } from "./repo.js";
import type { SkillStore, SkillsMirrorStatus } from "./store/index.js";

const log = logger.child({ component: "skills.mirror-reconcile" });

export interface SkillsMirrorReconcileDeps extends MirrorDeps {
  store: MirrorDeps["store"] & MirrorSyncStore & Pick<SkillStore, "recordMirrorBehind">;
  /** The bare skills repo. */
  repoPath: string;
}

type MirrorSyncStore = Pick<SkillStore, "lockMirror" | "markMainAdvanced" | "getMirror">;

/** The mirror row once `local_sha` is brought up to `main`. */
type MirrorAtMain =
  | { kind: "no_mirror" }
  | { kind: "unborn" }
  | { kind: "at_main"; status: SkillsMirrorStatus; localSha: string };

/** What one reconcile tick did. */
export type MirrorReconcileOutcome =
  | { kind: "no_origin" }
  | { kind: "no_mirror" }
  | { kind: "unborn" }
  | { kind: "synced" }
  | { kind: "pushed"; push: MirrorPushOutcome["kind"] }
  | { kind: "still_diverged" }
  | { kind: "resynced" };

/**
 * One reconcile of the skills remote (design/skills.md → Repo location →
 * Mirror state): bring `local_sha` up to `main`, then push it while `behind`,
 * recording the result; while `diverged`, read the remote's `main`: `synced`
 * once it equals `local_sha`, as after the owner's forced push, and `behind`,
 * then a push, once it is missing or an ancestor of `local_sha`. A push is
 * idempotent; an unborn `main` pushes nothing.
 */
export async function reconcileMirror(
  deps: SkillsMirrorReconcileDeps,
): Promise<MirrorReconcileOutcome> {
  if ((await readOriginUrl(deps.repoPath)) === null) return { kind: "no_origin" };
  return match(await syncLocalSha(deps, deps.repoPath))
    .returnType<Promise<MirrorReconcileOutcome>>()
    .with({ kind: P.union("no_mirror", "unborn") }, async ({ kind }) => ({ kind }))
    .with({ kind: "at_main", status: "synced" }, async () => ({ kind: "synced" }))
    .with({ kind: "at_main", status: "behind" }, async ({ localSha }) => {
      const push = await mirrorMain(deps, deps.repoPath, localSha);
      return { kind: "pushed", push: push.kind };
    })
    .with({ kind: "at_main", status: "diverged" }, async ({ localSha }) => {
      const remote = await readRemoteMain(deps, deps.repoPath);
      if (remote.isErr()) {
        log.warn({ error: remote.error.detail }, "skills remote unreadable while diverged");
        return { kind: "still_diverged" };
      }
      const remoteMain = remote.value;
      if (remoteMain === localSha) {
        const synced = await deps.runInTx((tx) => deps.store.recordMirrorLanded(tx, localSha));
        // Not synced: a deploy moved `main` since the read; the next tick
        // finds the remote behind it.
        if (!synced) return { kind: "still_diverged" };
        log.info({ sha: localSha }, "skills remote main matches local main again");
        return { kind: "resynced" };
      }
      // A remote `main` that is missing, or that local `main` descends from
      // again (an older `main` pushed by hand, or a deploy after the owner's
      // push whose own push failed), is only behind.
      if (
        remoteMain !== null &&
        !(await remoteMainIsAncestor(deps.repoPath, remoteMain, localSha))
      ) {
        return { kind: "still_diverged" };
      }
      const behind = await deps.runInTx((tx) => deps.store.recordMirrorBehind(tx, localSha));
      if (!behind) return { kind: "still_diverged" };
      log.info({ remoteMain, sha: localSha }, "skills remote main is behind local main again");
      const push = await mirrorMain(deps, deps.repoPath, localSha);
      return { kind: "pushed", push: push.kind };
    })
    .exhaustive();
}

/**
 * One reconcile, for `cogmo serve`'s boot before its runtime starts: a commit
 * the boot made (the layout commit) reaches the remote before a draft on a
 * git-remote backend can branch from the remote's `main`. Never rejects; a
 * failure is logged and the cron repeats the reconcile.
 */
export async function reconcileMirrorAtBoot(deps: SkillsMirrorReconcileDeps): Promise<void> {
  try {
    const outcome = await reconcileMirror(deps);
    log.info({ outcome: outcome.kind }, "skills mirror reconciled at boot");
  } catch (e) {
    log.warn(
      { error: describeError(e) },
      "skills mirror reconcile at boot failed; the cron repeats it",
    );
  }
}

/**
 * The mirror state's singleton, inserted `behind` when it is missing, by the
 * boot step that initialises the bare repo, under the bootstrap lock, with
 * `local_sha` brought up to `main`; the reconcile's first push records the
 * truth.
 */
export async function ensureSkillsMirror(
  deps: { runInTx: Transactor; store: MirrorSyncStore & Pick<SkillStore, "ensureMirror"> },
  repoPath: string,
): Promise<void> {
  await deps.runInTx((tx) => deps.store.ensureMirror(tx));
  await syncLocalSha(deps, repoPath);
}

/**
 * Bring `local_sha` up to `main`, as an advancing transaction does, for a
 * `main` that moved without one: an `update-ref` whose transaction then
 * failed to commit, or an operator's adopt in `cogmo migrate-skills-remote`.
 * `main` is read once the row is locked, so a deploy that marks the row
 * before its `update-ref` either waits for this read or makes this
 * transaction retry after it. An unborn `main` has nothing to mirror,
 * whatever sha the row last recorded; `no_mirror` is before the boot
 * inserts the row.
 */
async function syncLocalSha(
  deps: { runInTx: Transactor; store: MirrorSyncStore },
  repoPath: string,
): Promise<MirrorAtMain> {
  return deps.runInTx(async (tx): Promise<MirrorAtMain> => {
    if (!(await deps.store.lockMirror(tx))) return { kind: "no_mirror" };
    const mainSha = await getMainSha(repoPath);
    if (mainSha === null) return { kind: "unborn" };
    await deps.store.markMainAdvanced(tx, mainSha);
    const mirror = await deps.store.getMirror(tx);
    if (mirror === null) throw new Error("skills mirror row missing under its own lock");
    return { kind: "at_main", status: mirror.status, localSha: mainSha };
  });
}

export function createSkillsMirrorReconcile(deps: SkillsMirrorReconcileDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "skills-mirror-reconcile",
      // A failed tick leaves the mirror state as it was; the next one, 10 min
      // later, repeats it.
      retries: 0,
      concurrency: { limit: 1 },
      triggers: [{ cron: "*/10 * * * *" }],
    },
    async ({ step }) => fromStepTools(step).run("reconcile", () => reconcileMirror(deps)),
  );
}
