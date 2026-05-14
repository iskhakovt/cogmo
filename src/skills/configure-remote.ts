/**
 * Wizard + one-shot CLI helper for configuring the skills bare repo's
 * `origin` and syncing `coding_repos.skills.remote_url`.
 *
 * Industry tooling (`gh repo create --source --push`, `git clone`,
 * Pro Git §2.1) is one-directional with explicit mode: an "attach to a
 * fresh remote" tool pushes; a "clone an existing remote" tool fetches.
 * The caller picks the mode at invocation. Bidirectional auto-detect
 * isn't shipped anywhere we surveyed, and a tool that silently flips
 * direction based on local state is the exact data-loss surprise the
 * convention exists to avoid.
 *
 * So this helper is one-directional per call:
 *
 *   - `own + direction:"adopt"` — fetch remote `main` into local. Refuses
 *     when remote is empty or when local has commits that fetch would
 *     overwrite (git's fast-forward rejection, surfaced as
 *     `remote_diverged`).
 *   - `own + direction:"publish"` — push local `main` to remote. Refuses
 *     when local is empty or when remote has commits that push would
 *     overwrite (`local_diverged`).
 *   - `auto-provision` — Cogmo creates the GitHub repo. The direction is
 *     fully determined by local state: empty local gets a `auto_init:
 *     true` remote and adopts the README seed; populated local gets a
 *     `auto_init: false` empty remote and publishes its skills. The
 *     operator's choice of "auto-provision" already delegates the
 *     direction to Cogmo — no hidden mode-flip across different operator
 *     intents.
 *   - `skip` — no-op with logged warning.
 *
 * Wizard / CLI inspect local state up front and present mode-appropriate
 * prompt text ("publish to a new remote" vs. "fetch from a pre-populated
 * remote") so the operator always sees what's about to happen.
 *
 * After the transfer the helper calls `ensureSkillsCodingRepo` to sync
 * `coding_repos.skills.remote_url` — the orchestrator picks up the new
 * URL on its next read without a `cogmo serve` restart.
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
import {
  type EnsureSkillsCodingRepoResult,
  ensureSkillsCodingRepo,
  readOriginUrl,
} from "./repo.js";

const execFileP = promisify(execFile);
const log = logger.child({ component: "skills.configure-remote" });

/** Default name for the auto-provisioned GitHub repo. */
export const AUTO_PROVISION_REPO_NAME = "cogmo-skills";

/** Direction the helper transfers data in. The caller (wizard / CLI) picks
 * this based on local state — the helper never infers it for `own` mode. */
export type ConfigureSkillsRemoteDirection = "publish" | "adopt";

export type ConfigureSkillsRemoteMode =
  | {
      kind: "own";
      /** `publish` = push local → remote; `adopt` = fetch remote → local.
       * Caller-supplied so the operator's intent is always explicit. */
      direction: ConfigureSkillsRemoteDirection;
      remoteUrl: string;
      /** Optional GitHub identity for HTTPS askpass auth. Omit for SSH URLs
       * (ssh-agent / deploy keys handle auth) or for HTTPS to providers
       * Cogmo has no credentials for (the transfer may then fail). */
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
      direction: ConfigureSkillsRemoteDirection;
      /** Whether the bare repo's `origin` was newly attached, replaced, or already correct. */
      originAction: "attached" | "updated" | "unchanged";
      ensured: EnsureSkillsCodingRepoResult;
    };

export type ConfigureSkillsRemoteError =
  | { kind: "url_invalid"; remoteUrl: string; reason: string }
  | { kind: "remote_unreachable"; remoteUrl: string; reason: string }
  /** `adopt` only — remote has no `refs/heads/main`. Caller should have
   * routed this case to `publish` instead. */
  | { kind: "remote_empty"; remoteUrl: string }
  /** `publish` only — local has no commits on `main` to push. Caller should
   * have routed this case to `adopt` instead (and probably `auto-provision`,
   * which handles direction selection on its own). */
  | { kind: "local_empty"; remoteUrl: string }
  /** `adopt` — fast-forward fetch rejected because local has commits that
   * aren't on the remote. Fetching would orphan them. Operator resolves
   * outside the helper (`git push origin main` first, then re-run; or wipe
   * local intentionally with `git update-ref -d refs/heads/main`). */
  | { kind: "remote_diverged"; remoteUrl: string; localSha: string; remoteSha: string }
  /** `publish` — fast-forward push rejected because the remote has commits
   * that aren't on local. Pushing would orphan them. Operator resolves
   * outside the helper (`git fetch` first, then re-run; or force-overwrite
   * intentionally with raw git). */
  | { kind: "local_diverged"; remoteUrl: string; localSha: string; remoteSha: string }
  | { kind: "auto_provision_failed"; reason: string; status?: number }
  /** 422 on create — most often the operator already has `cogmo-skills`.
   * Surfaced separately so the UI can suggest switching to `own + adopt`
   * pointing at the existing repo. */
  | { kind: "auto_provision_repo_exists"; repoName: string };

/**
 * Configure the skills bare repo's `origin` and sync the DB row.
 *
 * Idempotent: re-running with the same URL + matching state is an
 * `unchanged` no-op. Re-running with a different URL updates origin via
 * `git remote set-url` and the DB row via `CodingStore.updateRepoRemoteUrl`.
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

  // Auto-provision picks its own direction based on local state; `own`
  // takes the caller's direction. Either way we end up with a concrete
  // direction + URL + auth before touching the bare repo's config.
  const resolved = await resolveTarget(deps, mode);
  if (resolved.isErr()) return err(resolved.error);
  const { remoteUrl, direction, pat } = resolved.value;

  if (!parseRemoteUrl(remoteUrl)) {
    return err({
      kind: "url_invalid",
      remoteUrl,
      reason: "URL must be a parseable git remote (https://host/owner/repo or git@host:owner/repo)",
    });
  }

  // Probe remote + local state. We hold the SHAs so the diverged error
  // can carry them, and so the post-transfer sync sees a coherent view.
  const lsRemote = await runLsRemote(deps.skillsRepoPath, remoteUrl, pat);
  if (lsRemote.isErr()) return err(lsRemote.error);
  const remoteMainSha = parseRemoteMainSha(lsRemote.value.refs);
  const localMainSha = await getLocalMainSha(deps.skillsRepoPath);

  // Direction-specific preconditions. The transfer itself enforces
  // fast-forward semantics; these checks turn the "empty source" cases
  // into precise error variants instead of opaque git messages.
  if (direction === "adopt" && remoteMainSha === null) {
    return err({ kind: "remote_empty", remoteUrl });
  }
  if (direction === "publish" && localMainSha === null) {
    return err({ kind: "local_empty", remoteUrl });
  }

  // Attach or update origin before the transfer so the operator sees a
  // consistent state if the transfer fails (origin matches what they
  // asked for; transfer error is recoverable by re-running).
  const originAction = await attachOrigin(deps.skillsRepoPath, remoteUrl);

  // Fast-forward transfer (no `+` in the refspec). git rejects on
  // non-fast-forward, which we map to `*_diverged` so operators see a
  // clear data-safety error instead of a raw git message.
  const transfer = await runTransfer({
    cwd: deps.skillsRepoPath,
    url: remoteUrl,
    direction,
    pat,
  });
  if (transfer.isErr()) {
    // origin was already attached above — we don't roll it back. The
    // operator's next invocation (after they resolve the divergence)
    // sees `unchanged` for origin and retries the transfer.
    return err({
      ...transfer.error,
      remoteUrl,
      // Best-effort SHA tagging — the probe already knows them.
      localSha: localMainSha ?? "",
      remoteSha: remoteMainSha ?? "",
    });
  }

  const ensured = await ensureSkillsCodingRepo(
    { runInTx: deps.runInTx, codingStore: deps.codingStore },
    { skillsRepoPath: deps.skillsRepoPath },
  );

  log.info(
    { remoteUrl, direction, originAction, ensuredKind: ensured.kind },
    "skills remote configured",
  );
  return ok({ kind: "configured", remoteUrl, direction, originAction, ensured });
}

interface ResolvedTarget {
  remoteUrl: string;
  direction: ConfigureSkillsRemoteDirection;
  /** PAT for HTTPS askpass; null for SSH or unauthenticated HTTPS. */
  pat: string | null;
}

async function resolveTarget(
  deps: ConfigureSkillsRemoteDeps,
  mode: Exclude<ConfigureSkillsRemoteMode, { kind: "skip" }>,
): Promise<Result<ResolvedTarget, ConfigureSkillsRemoteError>> {
  if (mode.kind === "own") {
    const url = mode.remoteUrl.trim();
    if (!url) {
      return err({ kind: "url_invalid", remoteUrl: url, reason: "URL is empty" });
    }
    const pat = url.startsWith("https://") && mode.identity ? mode.identity.pat : null;
    return ok({ remoteUrl: url, direction: mode.direction, pat });
  }
  // auto-provision — direction follows local state. Empty local means we
  // want the remote to seed our main (adopt); populated local means we
  // want to publish what we have. The `auto_init` flag matches: it gives
  // us the README seed when we need one, and an empty repo otherwise.
  const localMainSha = await getLocalMainSha(deps.skillsRepoPath);
  const direction: ConfigureSkillsRemoteDirection = localMainSha === null ? "adopt" : "publish";
  const repoName = mode.repoName ?? AUTO_PROVISION_REPO_NAME;
  const octokit =
    deps.octokitFactory?.(mode.identity.pat) ?? new Octokit({ auth: mode.identity.pat });
  try {
    const response = await octokit.repos.createForAuthenticatedUser({
      name: repoName,
      private: true,
      auto_init: direction === "adopt",
      description: "Cogmo skill library — managed by Cogmo",
    });
    log.info(
      { remoteUrl: response.data.clone_url, direction, autoInit: direction === "adopt" },
      "auto-provisioned GitHub skills repo",
    );
    return ok({ remoteUrl: response.data.clone_url, direction, pat: mode.identity.pat });
  } catch (e) {
    if (e instanceof RequestError) {
      if (e.status === 422) {
        return err({ kind: "auto_provision_repo_exists", repoName });
      }
      return err({ kind: "auto_provision_failed", reason: e.message, status: e.status });
    }
    return err({ kind: "auto_provision_failed", reason: (e as Error).message });
  }
}

async function attachOrigin(
  repoPath: string,
  remoteUrl: string,
): Promise<"attached" | "updated" | "unchanged"> {
  const currentOrigin = await readOriginUrl(repoPath);
  if (currentOrigin === remoteUrl) return "unchanged";
  if (currentOrigin === null) {
    await execFileP("git", ["-C", repoPath, "remote", "add", "origin", remoteUrl]);
    return "attached";
  }
  await execFileP("git", ["-C", repoPath, "remote", "set-url", "origin", remoteUrl]);
  return "updated";
}

interface TransferParams {
  cwd: string;
  url: string;
  direction: ConfigureSkillsRemoteDirection;
  pat: string | null;
}

/** Discriminator-only error (kind + reason) — `configureSkillsRemote`
 * attaches `remoteUrl`/`localSha`/`remoteSha` to the final error. */
type TransferError =
  | { kind: "remote_diverged" }
  | { kind: "local_diverged" }
  | { kind: "remote_unreachable"; reason: string };

async function runTransfer(p: TransferParams): Promise<Result<void, TransferError>> {
  // Fast-forward only — no `+` in the refspec. Git rejects non-FF with
  // a stderr message containing "non-fast-forward" or "rejected"; we
  // distinguish data-direction in the error variant by which side was
  // about to be overwritten.
  const refspec = "refs/heads/main:refs/heads/main";
  const args =
    p.direction === "publish"
      ? ["-C", p.cwd, "push", p.url, refspec]
      : ["-C", p.cwd, "fetch", p.url, refspec];
  try {
    if (p.pat) {
      await withGitAskpass(p.pat, (env) => runGit(args, env));
    } else {
      await runGit(args);
    }
    return ok(undefined);
  } catch (e) {
    const stderr = (e as Error).message ?? "";
    if (isNonFastForwardError(stderr)) {
      return err({ kind: p.direction === "publish" ? "local_diverged" : "remote_diverged" });
    }
    return err({ kind: "remote_unreachable", reason: stderr });
  }
}

/** Match the strings git emits on non-fast-forward rejection across `fetch`
 * and `push`. Covers both the standard message and the localized variants
 * we've seen on common distros. Adding new variants is cheap — adding a
 * match catches the case as a structured error instead of an
 * unhelpful `remote_unreachable`. */
function isNonFastForwardError(stderr: string): boolean {
  return (
    /non-fast-forward/i.test(stderr) ||
    /rejected\b/i.test(stderr) ||
    /\(non-fast-forward\)/i.test(stderr) ||
    /would not be a fast-forward/i.test(stderr)
  );
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

function parseRemoteMainSha(lsRemoteLines: string[]): string | null {
  for (const line of lsRemoteLines) {
    const [sha, ref] = line.split("\t");
    if (ref === "refs/heads/main" && sha) return sha;
  }
  return null;
}

async function getLocalMainSha(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", [
      "-C",
      repoPath,
      "rev-parse",
      "--verify",
      "refs/heads/main",
    ]);
    return stdout.trim();
  } catch {
    // `rev-parse --verify` exits non-zero when the ref doesn't exist.
    // Treat as unborn — `git init --bare` plus `symbolic-ref HEAD` leaves
    // refs/heads/main unborn until something writes it.
    return null;
  }
}
