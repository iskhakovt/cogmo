/**
 * Wizard + one-shot CLI helper for configuring the skills bare repo's
 * `origin` and syncing `coding_repos.skills.remote_url`.
 *
 * The bare repo at `$COGMO_SKILLS_PATH` needs a synchronized remote so that
 *
 *   - Daytona-backed coding delegation can clone from it, and
 *   - `register` can mirror the new `main` SHA to it after each fast-forward.
 *
 * Three operator-facing modes — same set the wizard surfaces, also reachable
 * via `cogmo migrate skills-remote`:
 *
 *   - `own` — operator-supplied URL. Validated via `git ls-remote`, attached
 *     as origin on the bare repo, refused when the remote is empty (no
 *     `main` to fetch).
 *   - `auto-provision` — Cogmo creates a private `cogmo-skills` repo on
 *     GitHub using the supplied identity, attaches the resulting clone URL
 *     as origin. GitHub-only by design: `auto-provision` is a wizard
 *     convenience, not a permanent provider-agnostic capability, so the
 *     octokit dependency stays scoped to this helper.
 *   - `skip` — no-op with a logged warning. `delegate_coding({repo:"skills"})`
 *     keeps failing until configured.
 *
 * Attaches/updates `origin` on the bare repo, then calls `ensureSkillsCodingRepo`
 * so `coding_repos.skills.remote_url` matches the bare repo's origin on the
 * orchestrator's next read — no `cogmo serve` restart required.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";
import { err, ok, type Result } from "neverthrow";
import { parseRemoteUrl } from "../agent/coding/draft-pr.js";
import type { CodingStore } from "../agent/coding/store/index.js";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import { runGit, withGitAskpass } from "../secrets/git-askpass.js";
import type { GitHubIdentity } from "../secrets/github.js";
import { type EnsureSkillsCodingRepoResult, ensureSkillsCodingRepo } from "./repo.js";

const execFileP = promisify(execFile);
const log = logger.child({ component: "skills.configure-remote" });

/** Default name for the auto-provisioned GitHub repo. */
export const AUTO_PROVISION_REPO_NAME = "cogmo-skills";

export type ConfigureSkillsRemoteMode =
  | {
      kind: "own";
      remoteUrl: string;
      /** Optional GitHub identity used for HTTPS askpass auth on validation/fetch.
       * Omit for SSH URLs (ssh-agent / deploy keys handle auth) or for HTTPS URLs
       * to providers Cogmo has no credentials for (validation may then fail). */
      identity?: GitHubIdentity;
    }
  | { kind: "auto-provision"; identity: GitHubIdentity; repoName?: string }
  | { kind: "skip" };

export interface ConfigureSkillsRemoteDeps {
  runInTx: Transactor;
  codingStore: CodingStore;
  /** Bare-repo path — usually `env.COGMO_SKILLS_PATH`. */
  skillsRepoPath: string;
  /** Octokit factory for tests. Production omits this so a real Octokit is
   * constructed against the supplied identity's PAT. */
  octokitFactory?: (pat: string) => Octokit;
}

export type ConfigureSkillsRemoteSuccess =
  | { kind: "skipped" }
  | {
      kind: "configured";
      remoteUrl: string;
      /** Whether the bare repo's `origin` was newly attached, replaced, or already correct. */
      originAction: "attached" | "updated" | "unchanged";
      ensured: EnsureSkillsCodingRepoResult;
    };

export type ConfigureSkillsRemoteError =
  | { kind: "url_invalid"; remoteUrl: string; reason: string }
  | { kind: "remote_unreachable"; remoteUrl: string; reason: string }
  /** Remote exists but has no `refs/heads/main`. `register` requires a base SHA. */
  | { kind: "remote_empty"; remoteUrl: string }
  | { kind: "auto_provision_failed"; reason: string; status?: number }
  /** 422 on create — most often the operator already has `cogmo-skills`.
   * Surfaced separately so the UI can suggest switching to `own` mode. */
  | { kind: "auto_provision_repo_exists"; repoName: string };

/**
 * Configure the skills bare repo's `origin` and sync the DB row.
 *
 * Idempotent: re-running with the same URL is an `unchanged` no-op. Re-running
 * with a different URL updates origin via `git remote set-url` and the DB row
 * via `CodingStore.updateRepoRemoteUrl`.
 */
export async function configureSkillsRemote(
  deps: ConfigureSkillsRemoteDeps,
  mode: ConfigureSkillsRemoteMode,
): Promise<Result<ConfigureSkillsRemoteSuccess, ConfigureSkillsRemoteError>> {
  if (mode.kind === "skip") {
    log.warn(
      { skillsRepoPath: deps.skillsRepoPath },
      "skills remote configuration skipped — delegate_coding({repo:'skills'}) will fail until configured",
    );
    return ok({ kind: "skipped" });
  }

  // Resolve target URL + optional PAT for HTTPS askpass.
  const resolved = await resolveTargetUrl(deps, mode);
  if (resolved.isErr()) return err(resolved.error);
  const { remoteUrl, pat } = resolved.value;

  // Validate URL shape and reachability before we touch the bare repo's
  // remote config — half-attached state is harder to reason about.
  if (!parseRemoteUrl(remoteUrl)) {
    return err({
      kind: "url_invalid",
      remoteUrl,
      reason: "URL must be a parseable git remote (https://host/owner/repo or git@host:owner/repo)",
    });
  }
  const lsRemote = await runLsRemote(deps.skillsRepoPath, remoteUrl, pat);
  if (lsRemote.isErr()) return err(lsRemote.error);
  const hasMain = lsRemote.value.refs.some((r) => r.endsWith("\trefs/heads/main"));
  if (!hasMain) {
    // No `refs/heads/main` to fetch. `register` and the coding pipeline both
    // need a populated `main`. Refuse rather than half-attach — the operator
    // initializes the remote (GitHub: `gh repo create --add-readme`; Gitea
    // / Forgejo: tick "Initialize Repository") and re-runs.
    return err({ kind: "remote_empty", remoteUrl });
  }

  // Attach or replace origin atomically per git's semantics.
  const currentOrigin = await readOriginUrl(deps.skillsRepoPath);
  let originAction: "attached" | "updated" | "unchanged";
  if (currentOrigin === remoteUrl) {
    originAction = "unchanged";
  } else if (currentOrigin === null) {
    await execFileP("git", ["-C", deps.skillsRepoPath, "remote", "add", "origin", remoteUrl]);
    originAction = "attached";
  } else {
    await execFileP("git", ["-C", deps.skillsRepoPath, "remote", "set-url", "origin", remoteUrl]);
    originAction = "updated";
  }

  // Fetch `main` so `register` has a base SHA. Force-update the local ref
  // since the bare repo's local-only `main` may not be a fast-forward of
  // what the remote carries (e.g. an operator re-pointed origin at a fresh
  // remote that didn't share history with the old one).
  await fetchMain(deps.skillsRepoPath, remoteUrl, pat);

  // Sync the DB row to whatever origin now reports — covers insert and
  // update paths uniformly.
  const ensured = await ensureSkillsCodingRepo(
    { runInTx: deps.runInTx, codingStore: deps.codingStore },
    { skillsRepoPath: deps.skillsRepoPath },
  );

  log.info({ remoteUrl, originAction, ensuredKind: ensured.kind }, "skills remote configured");
  return ok({ kind: "configured", remoteUrl, originAction, ensured });
}

interface ResolvedTarget {
  remoteUrl: string;
  /** PAT for HTTPS askpass; null for SSH or unauthenticated HTTPS. */
  pat: string | null;
}

async function resolveTargetUrl(
  deps: ConfigureSkillsRemoteDeps,
  mode: Exclude<ConfigureSkillsRemoteMode, { kind: "skip" }>,
): Promise<Result<ResolvedTarget, ConfigureSkillsRemoteError>> {
  if (mode.kind === "own") {
    const url = mode.remoteUrl.trim();
    if (!url) {
      return err({ kind: "url_invalid", remoteUrl: url, reason: "URL is empty" });
    }
    // HTTPS URLs need credentials; SSH URLs lean on ssh-agent / deploy keys.
    const pat = url.startsWith("https://") && mode.identity ? mode.identity.pat : null;
    return ok({ remoteUrl: url, pat });
  }
  // auto-provision
  const repoName = mode.repoName ?? AUTO_PROVISION_REPO_NAME;
  const octokit =
    deps.octokitFactory?.(mode.identity.pat) ?? new Octokit({ auth: mode.identity.pat });
  try {
    const response = await octokit.repos.createForAuthenticatedUser({
      name: repoName,
      private: true,
      auto_init: true,
      description: "Cogmo skill library — managed by Cogmo",
    });
    log.info({ remoteUrl: response.data.clone_url }, "auto-provisioned GitHub skills repo");
    return ok({ remoteUrl: response.data.clone_url, pat: mode.identity.pat });
  } catch (e) {
    if (e instanceof RequestError) {
      if (e.status === 422) {
        // Most common 422 cause: name already exists on this account.
        // Surfaced precisely so the UI can suggest switching to `own` mode
        // pointing at the existing repo or pick a different `repoName`.
        return err({ kind: "auto_provision_repo_exists", repoName });
      }
      return err({ kind: "auto_provision_failed", reason: e.message, status: e.status });
    }
    return err({ kind: "auto_provision_failed", reason: (e as Error).message });
  }
}

async function readOriginUrl(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoPath, "remote", "get-url", "origin"]);
    return stdout.trim();
  } catch (e) {
    // git exits with code 2 for "no such remote" — map to null, propagate everything else.
    if ((e as { code?: number }).code === 2) return null;
    throw e;
  }
}

interface LsRemoteOk {
  /** Raw `git ls-remote` lines (`<sha>\t<ref>`). */
  refs: string[];
}

async function runLsRemote(
  cwd: string,
  url: string,
  pat: string | null,
): Promise<Result<LsRemoteOk, ConfigureSkillsRemoteError>> {
  const args = ["-C", cwd, "ls-remote", "--heads", url];
  try {
    const result = pat ? await withGitAskpass(pat, (env) => runGit(args, env)) : await runGit(args);
    const refs = result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return ok({ refs });
  } catch (e) {
    return err({ kind: "remote_unreachable", remoteUrl: url, reason: (e as Error).message });
  }
}

async function fetchMain(cwd: string, url: string, pat: string | null): Promise<void> {
  // `+refs/heads/main:refs/heads/main` force-updates the bare repo's local
  // main to the remote's tip. Force is intentional: when an operator
  // re-points origin at a fresh remote, the old local main may not be an
  // ancestor of the new remote main, and we'd rather take the remote's
  // word for it than refuse the swap.
  const args = ["-C", cwd, "fetch", url, "+refs/heads/main:refs/heads/main"];
  if (pat) {
    await withGitAskpass(pat, (env) => runGit(args, env));
  } else {
    await runGit(args);
  }
}
