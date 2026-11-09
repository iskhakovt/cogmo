import { err, ok, type Result, ResultAsync } from "neverthrow";
import { match, P } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import { type GitEnv, runGit, withGitAskpass } from "../../secrets/git-askpass.js";
import { DEFAULT_GITHUB_IDENTITY_NAME, resolveGitHubIdentity } from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { describeError } from "../../util/describe-error.js";
import { getMainSha, isAncestor, revParse } from "../git-ops.js";
import { readOriginUrl } from "../repo.js";
import type { SkillStore, SkillsMirrorFailure } from "../store/index.js";

const log = logger.child({ component: "skills.mirror" });

/**
 * Cap on a push or a remote probe: one ref takes seconds, and a minute rides
 * out a slow link while still freeing the caller from a stalled connection.
 */
const MIRROR_TIMEOUT_MS = 60_000;

/** What pushing `main` to the skills remote, and reading the remote, need. */
export interface MirrorDeps {
  runInTx: Transactor;
  /** Resolves the GitHub identity an HTTPS remote authenticates with. */
  secretsStore: SecretsStore;
  store: Pick<SkillStore, "recordMirrorLanded" | "recordMirrorFailed" | "recordMirrorDiverged">;
}

/** The remote could not be read: unreachable, or its credentials refused. */
export interface RemoteUnreadable {
  kind: "unreadable";
  detail: string;
}

/** How one push of `main` to the skills remote went. */
export type MirrorPushOutcome =
  | { kind: "no_origin" }
  | { kind: "landed"; sha: string }
  | { kind: "failed"; failure: SkillsMirrorFailure; detail: string };

/**
 * Push `sha` to the skills remote's `main` and record the result in the
 * mirror state (design/skills.md → Repo location → Mirror state): a landed
 * push of `local_sha` is `synced`; a failed one keeps `behind` with its
 * cause; a rejection by a remote `main` that local `main` does not descend
 * from is `diverged`, while one by an older remote `main` lost to a newer
 * push and records nothing. Best-effort, after a deploy commits as from the
 * reconcile: local `main` and the database stay authoritative, so a failure
 * is recorded and logged, never thrown.
 *
 * The push gives up after `MIRROR_TIMEOUT_MS`, or once `signal` aborts.
 */
export async function mirrorMain(
  deps: MirrorDeps,
  repoPath: string,
  sha: string,
  options?: { signal?: AbortSignal },
): Promise<MirrorPushOutcome> {
  const outcome = await pushMain(deps, repoPath, sha, options).catch(
    (e: unknown): MirrorPushOutcome => ({
      kind: "failed",
      failure: "unreachable",
      detail: describeError(e),
    }),
  );
  try {
    await recordPush(deps, repoPath, outcome);
  } catch (e) {
    log.warn({ sha, error: describeError(e) }, "skills mirror push not recorded");
  }
  return outcome;
}

/** The remote's `main`, or null when it has none or there is no `origin`. */
export async function readRemoteMain(
  deps: Pick<MirrorDeps, "runInTx" | "secretsStore">,
  repoPath: string,
): Promise<Result<string | null, RemoteUnreadable>> {
  const remoteUrl = await readOriginUrl(repoPath);
  if (!remoteUrl) return ok(null);
  return ResultAsync.fromPromise(
    withRemoteAuth(deps, remoteUrl, (env) =>
      runGit(["-C", repoPath, "ls-remote", remoteUrl, "refs/heads/main"], env, {
        signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
      }),
    ),
    (e): RemoteUnreadable => ({ kind: "unreadable", detail: describeError(e) }),
  ).map(({ stdout }) => stdout.split("\t")[0]?.trim() || null);
}

async function pushMain(
  deps: Pick<MirrorDeps, "runInTx" | "secretsStore">,
  repoPath: string,
  sha: string,
  options: { signal?: AbortSignal } | undefined,
): Promise<MirrorPushOutcome> {
  const remoteUrl = await readOriginUrl(repoPath);
  if (!remoteUrl) return { kind: "no_origin" };
  const signal = AbortSignal.any([
    AbortSignal.timeout(MIRROR_TIMEOUT_MS),
    ...(options?.signal ? [options.signal] : []),
  ]);
  try {
    await withRemoteAuth(deps, remoteUrl, (env) =>
      runGit(["-C", repoPath, "push", remoteUrl, `${sha}:refs/heads/main`], env, { signal }),
    );
    return { kind: "landed", sha };
  } catch (e) {
    return { kind: "failed", failure: classifyPushFailure(e, signal), detail: describeError(e) };
  }
}

/** Why a push failed, from git's account of it. */
function classifyPushFailure(e: unknown, signal: AbortSignal): SkillsMirrorFailure {
  if (signal.aborted) return "timeout";
  const text = describeError(e);
  if (
    /\[remote rejected\]|protected branch|Authentication failed|Permission denied|could not read Username|\b40[13]\b/i.test(
      text,
    )
  ) {
    return "auth";
  }
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(text)) return "rejected";
  return "unreachable";
}

async function recordPush(
  deps: MirrorDeps,
  repoPath: string,
  outcome: MirrorPushOutcome,
): Promise<void> {
  await match(outcome)
    .with({ kind: "no_origin" }, async () => {
      log.warn(
        { repoPath },
        "skills bare repo has no `origin`; nothing to mirror (configure via `cogmo migrate-skills-remote`)",
      );
    })
    .with({ kind: "landed" }, async ({ sha }) => {
      const synced = await deps.runInTx((tx) => deps.store.recordMirrorLanded(tx, sha));
      // Not synced: a newer `main`, whose own push follows, is still to land.
      log.info({ sha, synced }, "mirrored skills main to remote");
    })
    .with({ kind: "failed", failure: "rejected" }, async ({ detail }) => {
      const lost = await lostToNewerPush(deps, repoPath);
      if (lost.isErr()) {
        log.warn(
          { detail, error: lost.error.detail },
          "skills remote rejected the push and could not be read; the reconcile retries",
        );
        return;
      }
      if (lost.value) return;
      const entered = await deps.runInTx((tx) => deps.store.recordMirrorDiverged(tx));
      log.warn(
        { detail, entered },
        "skills remote main diverged from local main; push local main to the remote by hand",
      );
    })
    .with(
      { kind: "failed", failure: P.union("unreachable", "auth", "timeout") },
      async ({ failure, detail }) => {
        await deps.runInTx((tx) => deps.store.recordMirrorFailed(tx, failure));
        log.warn(
          { failure, detail },
          "skills remote mirror failed; the reconcile retries — or `git -C $COGMO_SKILLS_PATH push origin main`",
        );
      },
    )
    .exhaustive();
}

/** Whether the remote's `main` is an ancestor of local `main`: a newer push won. */
async function lostToNewerPush(
  deps: Pick<MirrorDeps, "runInTx" | "secretsStore">,
  repoPath: string,
): Promise<Result<boolean, RemoteUnreadable>> {
  const remote = await readRemoteMain(deps, repoPath);
  if (remote.isErr()) return err(remote.error);
  const remoteMain = remote.value;
  const localMain = await getMainSha(repoPath);
  if (remoteMain === null || localMain === null) return ok(false);
  return ok(await remoteMainIsAncestor(repoPath, remoteMain, localMain));
}

/** Whether `remoteMain`, a sha read from the remote, is a commit here that `sha` descends from. */
export async function remoteMainIsAncestor(
  repoPath: string,
  remoteMain: string,
  sha: string,
): Promise<boolean> {
  return (
    (await revParse(repoPath, `${remoteMain}^{commit}`)).isOk() &&
    (await isAncestor(repoPath, remoteMain, sha))
  );
}

/** Run `fn` against `remoteUrl`, with the GitHub identity's token for an HTTPS remote. */
async function withRemoteAuth<T>(
  deps: Pick<MirrorDeps, "runInTx" | "secretsStore">,
  remoteUrl: string,
  fn: (env?: GitEnv) => Promise<T>,
): Promise<T> {
  // SSH remotes use ssh-agent or deploy keys; only HTTPS reads the identity.
  if (!remoteUrl.startsWith("https://")) return fn();
  const identity = await deps.runInTx((tx) =>
    resolveGitHubIdentity(tx, deps.secretsStore, DEFAULT_GITHUB_IDENTITY_NAME),
  );
  return identity.isOk() ? withGitAskpass(identity.value.pat, fn) : fn();
}
