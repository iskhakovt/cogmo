import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import { type GitEnv, runGit, withGitAskpass } from "../../secrets/git-askpass.js";
import { DEFAULT_GITHUB_IDENTITY_NAME, resolveGitHubIdentity } from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { readOriginUrl } from "../repo.js";

const log = logger.child({ component: "skills.runner" });

/**
 * Cap on the mirror push: pushing one ref takes seconds, and a minute rides
 * out a slow link while still freeing the caller from a stalled connection.
 */
const MIRROR_PUSH_TIMEOUT_MS = 60_000;

/**
 * Mirror the bare repo's `refs/heads/main` to its configured `origin` after
 * a successful `register` / `approveDeploy` / `rollback`. Without this, the
 * local bare repo's main advances but the remote stays stale, and any
 * Daytona-backed coding task cloning from the remote (see
 * `design/sandbox.md` → git-remote transport) operates on an outdated
 * skill set.
 *
 * Non-blocking failure: if the push fails (network blip, lease check
 * failed, credentials revoked), the local register is *still* the truth.
 * We log a warning and let the next register reconcile, or the operator
 * run `git -C $COGMO_SKILLS_PATH push origin main` manually. Throwing
 * here would force a rollback of the DB transaction that already committed
 * — strictly worse than eventual consistency.
 *
 * Concurrency model: `register` is the only legitimate writer of remote
 * main. `force` is opt-in for `rollback` (which intentionally rewrites
 * history); register/approve use fast-forward push which fails clearly
 * if the remote has somehow drifted.
 *
 * The push gives up after `MIRROR_PUSH_TIMEOUT_MS`, or once `signal`
 * aborts: git is killed, and the push fails like any other.
 */
export async function mirrorMainToRemote(
  deps: { runInTx: Transactor; secretsStore: SecretsStore },
  repoPath: string,
  newSha: string,
  options?: { force?: { expectedRemoteSha: string }; signal?: AbortSignal },
): Promise<void> {
  const remoteUrl = await readOriginUrl(repoPath);
  if (!remoteUrl) {
    log.warn(
      { newSha, repoPath },
      "skills bare repo has no `origin` — skipping remote mirror (configure via `cogmo migrate-skills-remote`)",
    );
    return;
  }

  // HTTPS URLs need credential helper; SSH URLs use ssh-agent / deploy keys.
  // We only resolve the GitHub identity for HTTPS to avoid pulling a
  // possibly-missing secret on SSH-only setups.
  let pat: string | null = null;
  if (remoteUrl.startsWith("https://")) {
    const identity = await deps.runInTx((tx) =>
      resolveGitHubIdentity(tx, deps.secretsStore, DEFAULT_GITHUB_IDENTITY_NAME),
    );
    if (identity.isOk()) pat = identity.value.pat;
  }

  const args = ["-C", repoPath, "push"];
  if (options?.force) {
    args.push(`--force-with-lease=refs/heads/main:${options.force.expectedRemoteSha}`);
  }
  args.push(remoteUrl, `${newSha}:refs/heads/main`);

  const signal = AbortSignal.any([
    AbortSignal.timeout(MIRROR_PUSH_TIMEOUT_MS),
    ...(options?.signal ? [options.signal] : []),
  ]);
  const push = (env?: GitEnv) => runGit(args, env, { signal });
  try {
    await (pat ? withGitAskpass(pat, push) : push());
    log.info({ newSha, remoteUrl }, "mirrored skills main to remote");
  } catch (e) {
    log.warn(
      { newSha, remoteUrl, error: (e as Error).message },
      "skills remote mirror push failed; local state is authoritative — retry with `git -C $COGMO_SKILLS_PATH push origin main`",
    );
  }
}
