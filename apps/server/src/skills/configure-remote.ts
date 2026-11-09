/**
 * Wizard + one-shot CLI helper for configuring the skills bare repo's
 * `origin` and syncing `coding_repos.skills.remote_url`. One-directional
 * per call — the caller picks `publish` or `adopt` at invocation:
 *
 *   - `own + direction:"adopt"` — fetch remote `main` into local. Refuses
 *     when remote is empty (`remote_empty`), when local has commits
 *     that fetch would overwrite (`remote_diverged`), or when the remote's
 *     `.cogmo/paths` lists an entry Cogmo's toolchain may not own
 *     (`remote_toolchain_invalid`). A Cogmo-only local `main` counts as
 *     empty: the adopt replaces it.
 *   - `own + direction:"publish"` — push local `main` to remote. Refuses
 *     when local is empty (`local_empty`) or when remote has commits
 *     that push would overwrite (`local_diverged`).
 *   - `auto-provision` — Cogmo creates the GitHub repo and picks direction
 *     from local state: empty local gets `auto_init: true` and adopts the
 *     README seed; populated local gets `auto_init: false` and publishes
 *     its skills.
 *   - `skip` — no-op with logged warning.
 *
 * Wizard / CLI inspect local state up front and present mode-appropriate
 * prompts so the operator always sees what's about to happen.
 *
 * After the transfer the helper calls `ensureSkillsCodingRepo` to sync
 * `coding_repos.skills.remote_url` — the orchestrator picks up the new
 * URL on its next read without a `cogmo serve` restart.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";
import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { parseRemoteUrl } from "../agent/coding/open-pr.js";
import type { CodingRepoRow, CodingStore } from "../agent/coding/store/index.js";
import type { BootstrapLock } from "../db/bootstrap-lock.js";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import { runGit, withGitAskpass } from "../secrets/git-askpass.js";
import type { GitHubIdentity } from "../secrets/github.js";
import { describeError } from "../util/describe-error.js";
import { ZERO_SHA } from "./deploy/deploy-deps.js";
import {
  deleteRef,
  getMainSha,
  isAncestor,
  RefMovedError,
  revParse,
  updateRef,
} from "./git-ops.js";
import { configurableMainSha, isCogmoOnlyMain, migrateSkillsLayout } from "./migrate-layout.js";
import {
  type EnsureSkillsCodingRepoResult,
  ensureSkillsCodingRepo,
  readOriginUrl,
  SKILLS_CODING_REPO_NAME,
} from "./repo.js";
import type { SkillStore } from "./store/index.js";
import { type ReleaseToolchain, toolchainPathsAt } from "./toolchain.js";
import { commitToolchain } from "./toolchain-commit.js";

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
  /** Re-records the layout after an adopt replaces a Cogmo-only `main`. */
  skillStore: SkillStore;
  /** Held from the classification of `main` through an adopt's toolchain commit. */
  bootstrapLock: BootstrapLock;
  /** The release's toolchain, committed after an adopt replaces a Cogmo-only `main`. */
  toolchain: ReleaseToolchain;
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
      /** Path to the JSON dump of the prior `coding_repos.skills` row,
       * written before any mutation. Null when there was no row to back up
       * (fresh install). The caller (wizard / CLI) logs this so the operator
       * can roll back manually if needed. */
      backupPath: string | null;
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
  /** `adopt` — the remote's `main` has a `.cogmo/paths` listing `entry`, which
   * the toolchain may not own (design/skills.md → The skills repo toolchain).
   * Local `main` is untouched; the operator fixes the list on the remote. */
  | { kind: "remote_toolchain_invalid"; remoteUrl: string; entry: string }
  /** `publish` — fast-forward push rejected because the remote has commits
   * that aren't on local. Pushing would orphan them. Operator resolves
   * outside the helper (`git fetch` first, then re-run; or force-overwrite
   * intentionally with raw git). */
  | { kind: "local_diverged"; remoteUrl: string; localSha: string; remoteSha: string }
  /** Transfer succeeded but `git remote add` / `set-url` failed (FS error,
   * server-side hook reject on a misconfigured bare repo, etc.). Bare repo
   * may be left without an attached origin even though the transfer landed —
   * re-run the helper to retry. */
  | { kind: "origin_attach_failed"; remoteUrl: string; reason: string }
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

  // Probe remote state. We hold the SHA so the diverged error can carry it.
  const lsRemote = await runLsRemote(deps.skillsRepoPath, remoteUrl, pat);
  if (lsRemote.isErr()) return err(lsRemote.error);
  const remoteMainSha = parseRemoteMainSha(lsRemote.value.refs);

  // The empty-source preconditions turn into precise error variants instead
  // of opaque git messages; the transfer itself enforces fast-forward.
  if (direction === "adopt" && remoteMainSha === null) {
    return err({ kind: "remote_empty", remoteUrl });
  }

  // From the classification of local main through an adopt's toolchain
  // commit, under the bootstrap lock, so a boot's layout move and toolchain
  // commit never interleave with the adopt's (design/skills.md → Cogmo-only
  // `main`). If the transfer fails, the bare repo's `origin` config is
  // untouched and the next boot's `ensureSkillsCodingRepo` won't sync a
  // stale URL into the DB row.
  const transferred = await deps.bootstrapLock(
    async (): Promise<Result<TransferOutcome, ConfigureSkillsRemoteError>> => {
      // One read, so an adopt's swap expects the commit classified.
      const local = await classifyLocalMain(deps.skillsRepoPath);
      const localMainSha = match(local)
        .with({ kind: "populated" }, ({ sha }) => sha)
        .with({ kind: "unborn" }, { kind: "cogmo_only" }, () => null)
        .exhaustive();
      if (direction === "publish" && localMainSha === null) {
        return err({ kind: "local_empty", remoteUrl });
      }
      const transfer = await match(direction)
        .with("publish", () => runPush({ cwd: deps.skillsRepoPath, url: remoteUrl, pat }))
        .with("adopt", () => adoptRemoteMain(deps, { url: remoteUrl, pat, local }))
        .exhaustive();
      if (transfer.isOk()) return ok(transfer.value);
      // Branch on kind so the error variants stay clean — spreading
      // `transfer.error` and tacking on SHAs would add fields the other
      // variants don't declare.
      return err(
        await match(transfer.error)
          .returnType<Promise<ConfigureSkillsRemoteError>>()
          .with({ kind: "remote_unreachable" }, async (e) => ({
            kind: "remote_unreachable",
            remoteUrl,
            reason: e.reason,
          }))
          .with({ kind: "remote_toolchain_invalid" }, async (e) => ({
            kind: "remote_toolchain_invalid",
            remoteUrl,
            entry: e.entry,
          }))
          .with({ kind: "remote_diverged" }, { kind: "local_diverged" }, async (e) => {
            // Both sides have main: the empty-source preconditions above
            // guarantee the remote's for an adopt and the local one for a
            // publish, and an adopt over a Cogmo-only main diverges only when
            // a deploy moved local main meanwhile. A null probe here is a
            // transient git failure — surface it as a boundary violation
            // rather than rendering "localSha: " to the operator.
            const localSha = localMainSha ?? (await getMainSha(deps.skillsRepoPath));
            if (localSha === null || remoteMainSha === null) {
              throw new Error(
                `configureSkillsRemote: ${e.kind} fired but state probe returned null (localMainSha=${String(
                  localSha,
                )}, remoteMainSha=${String(remoteMainSha)})`,
              );
            }
            return { kind: e.kind, remoteUrl, localSha, remoteSha: remoteMainSha };
          })
          .exhaustive(),
      );
    },
  );
  if (transferred.isErr()) return err(transferred.error);

  // Transfer succeeded — now persist the operator's intent by attaching
  // (or replacing) origin. From the bare repo's view, origin always
  // reflects the URL we just successfully transferred to/from. Failure
  // here is rare (FS errors, hook reject on a misconfigured bare repo)
  // but surfaced as a structured `origin_attach_failed` error rather
  // than a thrown exception so the helper's Result contract holds end-
  // to-end.
  const attached = await attachOrigin(deps.skillsRepoPath, remoteUrl);
  if (attached.isErr()) {
    return err({ kind: "origin_attach_failed", remoteUrl, reason: attached.error });
  }
  const originAction = attached.value;

  await match(transferred.value)
    .with("replaced", async () => {
      // The remote lacks the layout and toolchain commits the adopt just
      // made, and a git-remote task branches from the remote's main.
      // Best-effort, like a deploy's push.
      const pushed = await runPush({ cwd: deps.skillsRepoPath, url: remoteUrl, pat });
      if (pushed.isErr()) {
        log.warn(
          { remoteUrl, error: pushed.error },
          "skills layout and toolchain commits not pushed after adopt; the mirror reconcile pushes them within 10 minutes",
        );
      }
    })
    .with("published", "fast_forward", async () => {})
    .exhaustive();

  // Backup the current row (if any) before ensureSkillsCodingRepo
  // potentially updates `remote_url`. Operator-recoverable trace of the
  // pre-change state — the CLI's path was the prior backup convention;
  // moved inside the helper so both the CLI and the wizard's `replace`
  // path get it without duplicating fs logic across callers.
  const existingRow = await deps.runInTx((tx) =>
    deps.codingStore.getRepoByName(tx, SKILLS_CODING_REPO_NAME),
  );
  const backupPath = existingRow ? await writeBackup(existingRow) : null;

  const ensured = await ensureSkillsCodingRepo(
    { runInTx: deps.runInTx, codingStore: deps.codingStore },
    { skillsRepoPath: deps.skillsRepoPath },
  );

  log.info(
    { remoteUrl, direction, originAction, ensuredKind: ensured.kind, backupPath },
    "skills remote configured",
  );
  return ok({
    kind: "configured",
    remoteUrl,
    direction,
    originAction,
    ensured,
    backupPath,
  });
}

/** Directory the helper writes pre-mutation row dumps to. Same convention as
 * `cogmo migrate-memories` — `.dev/skills-backups/<iso-timestamp>.json`. */
const BACKUP_DIR = ".dev/skills-backups";

async function writeBackup(row: CodingRepoRow): Promise<string> {
  await mkdir(BACKUP_DIR, { recursive: true });
  const path = join(BACKUP_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(path, JSON.stringify(row, null, 2));
  return path;
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
  const localMainSha = await configurableMainSha(deps.skillsRepoPath);
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
): Promise<Result<"attached" | "updated" | "unchanged", string>> {
  try {
    const currentOrigin = await readOriginUrl(repoPath);
    if (currentOrigin === remoteUrl) return ok("unchanged");
    if (currentOrigin === null) {
      await execFileP("git", ["-C", repoPath, "remote", "add", "origin", remoteUrl]);
      return ok("attached");
    }
    await execFileP("git", ["-C", repoPath, "remote", "set-url", "origin", remoteUrl]);
    return ok("updated");
  } catch (e) {
    return err((e as Error).message);
  }
}

/**
 * Local `main` as configuring a remote sees it: a Cogmo-only `main` carries no
 * skill to keep, so an adopt replaces it and a publish has nothing to push.
 */
type LocalMain =
  | { kind: "unborn" }
  | { kind: "cogmo_only"; sha: string }
  | { kind: "populated"; sha: string };

async function classifyLocalMain(repoPath: string): Promise<LocalMain> {
  const sha = await getMainSha(repoPath);
  if (sha === null) return { kind: "unborn" };
  return (await isCogmoOnlyMain(repoPath, sha))
    ? { kind: "cogmo_only", sha }
    : { kind: "populated", sha };
}

/** How a transfer moved local `main`: not at all (a publish), forward, or replacing a Cogmo-only one. */
type TransferOutcome = "published" | "fast_forward" | "replaced";

/** Discriminator-only error (kind + reason) — `configureSkillsRemote`
 * attaches `remoteUrl`/`localSha`/`remoteSha` to the final error. */
type TransferError =
  | { kind: "remote_diverged" }
  | { kind: "local_diverged" }
  | { kind: "remote_unreachable"; reason: string }
  | { kind: "remote_toolchain_invalid"; entry: string };

/** Where adopts fetch the remote's main, one ref each. */
const ADOPT_REF_PREFIX = "refs/cogmo/adopt-main-";

/**
 * Adopt the remote's main: fetch it to a side ref and refuse a `.cogmo/paths`
 * on it listing an entry the toolchain may not own, before `main` moves. A
 * Cogmo-only `main` is replaced ({@link replaceCogmoOnlyMain}); any other
 * only fast-forwards. The caller holds the bootstrap lock.
 */
async function adoptRemoteMain(
  deps: ConfigureSkillsRemoteDeps,
  p: { url: string; pat: string | null; local: LocalMain },
): Promise<Result<TransferOutcome, TransferError>> {
  // Its own ref, so a concurrent adopt neither resolves nor deletes it.
  const adoptRef = `${ADOPT_REF_PREFIX}${randomUUID()}`;
  const args = ["-C", deps.skillsRepoPath, "fetch", p.url, `+refs/heads/main:${adoptRef}`];
  try {
    try {
      if (p.pat) {
        await withGitAskpass(p.pat, (env) => runGit(args, env));
      } else {
        await runGit(args);
      }
    } catch (e) {
      return err({ kind: "remote_unreachable", reason: describeError(e) });
    }
    const adopted = await revParse(deps.skillsRepoPath, adoptRef);
    if (adopted.isErr()) {
      throw new Error(`configureSkillsRemote: ${adoptRef} is missing right after its fetch`);
    }
    const listed = await toolchainPathsAt(deps.skillsRepoPath, adopted.value);
    if (listed.isErr()) {
      return err(
        match(listed.error)
          .returnType<TransferError>()
          .with({ kind: "refused_entry" }, ({ entry }) => ({
            kind: "remote_toolchain_invalid",
            entry,
          }))
          .exhaustive(),
      );
    }
    return await match(p.local)
      .returnType<Promise<Result<TransferOutcome, TransferError>>>()
      .with({ kind: "cogmo_only" }, ({ sha }) => replaceCogmoOnlyMain(deps, adopted.value, sha))
      .with({ kind: "unborn" }, () => fastForwardMain(deps.skillsRepoPath, adopted.value, null))
      .with({ kind: "populated" }, ({ sha }) =>
        fastForwardMain(deps.skillsRepoPath, adopted.value, sha),
      )
      .exhaustive();
  } finally {
    await deleteRef(deps.skillsRepoPath, adoptRef);
  }
}

/**
 * Replace a Cogmo-only `main` at `mainSha` with `adopted`: drop the layout
 * row, swap `main` by compare-and-swap against the commit classified, then
 * run the layout move and the toolchain commit (design/skills.md → Per-skill
 * structure, failure modes). A lost swap records the layout again and is
 * `remote_diverged`.
 */
async function replaceCogmoOnlyMain(
  deps: ConfigureSkillsRemoteDeps,
  adopted: string,
  mainSha: string,
): Promise<Result<TransferOutcome, TransferError>> {
  const relayout = () =>
    migrateSkillsLayout({ runInTx: deps.runInTx, store: deps.skillStore }, deps.skillsRepoPath);
  await deps.runInTx((tx) => deps.skillStore.forgetLayoutCommit(tx));
  try {
    await updateRef(deps.skillsRepoPath, "refs/heads/main", adopted, mainSha);
  } catch (e) {
    if (!(e instanceof RefMovedError)) throw e;
    await relayout();
    return err({ kind: "remote_diverged" });
  }
  await relayout();
  const toolchain = await commitToolchain(
    { runInTx: deps.runInTx, store: deps.skillStore },
    deps.skillsRepoPath,
    deps.toolchain,
  );
  if (toolchain.isErr()) {
    // The adopt checked this main's list before the swap, and register
    // refuses an author's change to it.
    throw match(toolchain.error)
      .with(
        { kind: "refused_entry" },
        ({ entry }) =>
          new Error(
            `configureSkillsRemote: the adopted main lists '${entry}' in its .cogmo/paths after its check passed`,
          ),
      )
      .exhaustive();
  }
  return ok("replaced");
}

/**
 * Move `main` to `adopted` when that only fast-forwards it: `main` unborn, or
 * an ancestor of `adopted`. A `main` that is not, or moves before the
 * compare-and-swap, has commits the remote lacks.
 */
async function fastForwardMain(
  repoPath: string,
  adopted: string,
  mainSha: string | null,
): Promise<Result<TransferOutcome, TransferError>> {
  if (mainSha !== null && !(await isAncestor(repoPath, mainSha, adopted))) {
    return err({ kind: "remote_diverged" });
  }
  try {
    await updateRef(repoPath, "refs/heads/main", adopted, mainSha ?? ZERO_SHA);
  } catch (e) {
    if (!(e instanceof RefMovedError)) throw e;
    return err({ kind: "remote_diverged" });
  }
  return ok("fast_forward");
}

/**
 * Push local `main` to the remote, fast-forward only — no `+` in the refspec.
 * Git rejects non-FF with a stderr message containing "non-fast-forward" or
 * "rejected", which maps to `local_diverged`: the remote's side would be
 * overwritten.
 */
async function runPush(p: {
  cwd: string;
  url: string;
  pat: string | null;
}): Promise<Result<TransferOutcome, TransferError>> {
  const args = ["-C", p.cwd, "push", p.url, "refs/heads/main:refs/heads/main"];
  try {
    if (p.pat) {
      await withGitAskpass(p.pat, (env) => runGit(args, env));
    } else {
      await runGit(args);
    }
    return ok("published");
  } catch (e) {
    const stderr = (e as Error).message ?? "";
    if (isNonFastForwardError(stderr)) return err({ kind: "local_diverged" });
    return err({ kind: "remote_unreachable", reason: stderr });
  }
}

/** Match the strings git emits specifically for non-fast-forward rejection
 * across `fetch` and `push`. Patterns are anchored to non-FF wording —
 * a bare `[rejected]` token would also fire on auth failures and
 * server-side policy rejections (pre-receive hook decline, branch
 * protection, etc.), which then get mis-labeled as `local_diverged` /
 * `remote_diverged` and send the operator down the wrong remediation
 * path.
 *
 * git push uses two variants of the rejection label: `(non-fast-forward)`
 * (legacy) and `(fetch first)` (current — appears when the remote has
 * commits not in local). Both mean non-FF. The "Updates were rejected
 * because" hint prefix is the canonical operator-facing signal — git emits
 * one of two trailers ("tip of your current branch is behind" or "remote
 * contains work that you do not have locally") depending on which
 * variant fired. Matching the hint prefix catches both with one
 * pattern. */
function isNonFastForwardError(stderr: string): boolean {
  return (
    /\(non-fast-forward\)/i.test(stderr) ||
    /\(fetch first\)/i.test(stderr) ||
    /Updates were rejected because/i.test(stderr) ||
    /is not a fast[- ]forward/i.test(stderr) ||
    /would not be a fast[- ]forward/i.test(stderr)
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
