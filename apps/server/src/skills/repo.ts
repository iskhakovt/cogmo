import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CodingStore } from "../agent/coding/store/index.js";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";

const execFileP = promisify(execFile);
const log = logger.child({ component: "skills.repo" });

/**
 * Well-known `coding_repos.name` for the skill library. `delegate_coding`
 * resolves repo config by name, so this string is part of the
 * agent-facing contract — see `src/skills/skills-tool.ts`'s
 * `SKILLS_PROMPT_GUIDANCE`.
 */
export const SKILLS_CODING_REPO_NAME = "skills";

/**
 * Pre-receive hook installed on the bare skills repo. Enforces two invariants
 * (`design/skills.md` → Repo invariants):
 *
 *   1. Direct pushes to `main` are rejected unconditionally. Cogmo advances
 *      `main` via `git update-ref` directly on the bare repo's filesystem,
 *      bypassing the hook by design. No env-var escape hatch.
 *
 *   2. Force pushes / non-fast-forward updates are rejected on every branch.
 *      `skill_deploys.git_sha` references specific commits; rewriting history
 *      would dangle live skills.
 */
const ZERO_REF = "0000000000000000000000000000000000000000";

// POSIX `/bin/sh` (no bash-isms in the body) so the hook runs on hosts
// shipping only dash/busybox-ash. The script uses only `[ ... ]`, `read`,
// `echo`, and `git` — all in POSIX.
const PRE_RECEIVE_HOOK = `#!/bin/sh
# Managed by Cogmo (src/skills/repo.ts). Do not edit — overwritten on boot.

while read oldrev newrev refname; do
  if [ "$refname" = "refs/heads/main" ]; then
    echo "Direct pushes to main are not allowed. Use 'cogmo skills register'." >&2
    exit 1
  fi
  # Skip create / delete (zero ref); only validate fast-forward on updates.
  if [ "$oldrev" != "${ZERO_REF}" ] && [ "$newrev" != "${ZERO_REF}" ]; then
    if ! git merge-base --is-ancestor "$oldrev" "$newrev"; then
      echo "Force push / non-fast-forward not allowed on $refname" >&2
      exit 1
    fi
  fi
done
`;

export interface BootstrapSkillsRepoResult {
  /** True iff `git init --bare` ran in this call (i.e. the repo did not exist before). */
  initialized: boolean;
  /** Absolute path of the bare repo. */
  path: string;
}

/**
 * Idempotently bring the skills bare repo to its expected state. Safe to call
 * on every boot — the hook is rewritten unconditionally so a Cogmo upgrade
 * that tightens the policy takes effect on existing deployments. The repo
 * itself is only created on first call.
 *
 * HEAD is pinned to `refs/heads/main` unconditionally via `symbolic-ref`.
 * `git init` honours the host's `init.defaultBranch` config (still `master`
 * on older git or hosts that never opted in), and the `pre-receive` hook
 * gates only `main` — a HEAD pointing at `master` would let direct pushes
 * to `master` slip the gate and would hand any pre-first-register clone
 * an empty `master` working tree. The `symbolic-ref` call runs on every
 * boot so existing deployments converge without an operator step; we
 * deliberately don't pass `--initial-branch=main` to `git init` because
 * it's a 2.28+-only flag and the `symbolic-ref` line below makes the same
 * guarantee on every git version without a compat gate.
 */
export async function bootstrapSkillsRepo(params: {
  path: string;
}): Promise<BootstrapSkillsRepoResult> {
  const repoPath = params.path;
  await mkdir(repoPath, { recursive: true });

  const initialized = !existsSync(join(repoPath, "HEAD"));
  if (initialized) {
    log.info({ path: repoPath }, "initializing bare skills repo");
    await execFileP("git", ["init", "--bare", repoPath]);
  }

  await execFileP("git", ["-C", repoPath, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await installHook(repoPath, "pre-receive", PRE_RECEIVE_HOOK);

  return { initialized, path: repoPath };
}

/**
 * Atomically write a hook file and chmod it executable. Atomicity (write to
 * `.tmp` + rename) prevents a half-written hook from being executed if the
 * process is killed mid-boot — Linux `rename(2)` is atomic on the same
 * filesystem.
 */
async function installHook(repoPath: string, name: string, content: string): Promise<void> {
  const hookPath = join(repoPath, "hooks", name);
  const tmpPath = `${hookPath}.tmp`;
  await mkdir(dirname(hookPath), { recursive: true });
  await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o755 });
  await chmod(tmpPath, 0o755);
  await rename(tmpPath, hookPath);
}

/** Exported for tests so they can assert the hook content matches what was installed. */
export const PRE_RECEIVE_HOOK_CONTENT: string = PRE_RECEIVE_HOOK;

/**
 * Read `origin` URL from a git repo. Returns `null` when no `origin` is set
 * (`git remote get-url` exits 2); any other git failure is propagated —
 * silently swallowing it would mask a corrupt repo or missing git as "no
 * remote", which is a worse failure mode than crashing.
 *
 * Shared across the wizard, the `cogmo migrate-skills-remote` CLI, the
 * `configureSkillsRemote` helper, and the runner's mirror-push path.
 */
export async function readOriginUrl(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoPath, "remote", "get-url", "origin"]);
    return stdout.trim();
  } catch (e) {
    if ((e as { code?: number }).code === 2) return null;
    throw e;
  }
}

export type EnsureSkillsCodingRepoResult =
  | {
      /** No `origin` on the bare repo. Row is not inserted; `delegate_coding({repo:"skills"})`
       * will fail until the operator runs the wizard or `cogmo migrate-skills-remote`. */
      kind: "skipped_no_origin";
      localPath: string;
    }
  | {
      /** Row inserted on this call. */
      kind: "created";
      name: string;
      localPath: string;
      remoteUrl: string;
    }
  | {
      /** Existing row's `remote_url` was stale and has been updated to match the bare repo's origin. */
      kind: "updated";
      name: string;
      localPath: string;
      remoteUrl: string;
      previousRemoteUrl: string;
    }
  | {
      /** Row already present and in sync — no-op. */
      kind: "unchanged";
      name: string;
      localPath: string;
      remoteUrl: string;
    };

export interface EnsureSkillsCodingRepoDeps {
  runInTx: Transactor;
  codingStore: CodingStore;
}

export interface EnsureSkillsCodingRepoArgs {
  skillsRepoPath: string;
}

/**
 * Idempotently ensure `coding_repos.skills` reflects the bare repo's current
 * `origin`. Called at boot and at the end of {@link configureSkillsRemote}.
 *
 * The bare repo's `origin` is the source of truth — this function mirrors it
 * into the DB row. Four outcomes (discriminated by `kind`):
 *
 *   - `skipped_no_origin` — bare repo has no `origin` attached. We refuse to
 *     write a `remote_url=""` row because the coding-delegation pipeline
 *     can't operate without a reachable remote (Daytona clones from it,
 *     `register` mirrors `main` to it). The wizard / `cogmo migrate
 *     skills-remote` CLI is the path to attach one.
 *   - `created` — no row existed, origin is present: row inserted.
 *   - `updated` — row existed with a stale `remote_url`: column updated. This
 *     is the one mutation we allow on the otherwise insert-once
 *     `coding_repos` table; see `CodingStore.updateRepoRemoteUrl`.
 *   - `unchanged` — row present and in sync.
 *
 * Defaults on first insert match the per-repo knobs `Transport.repos.add`
 * uses for user-added repos. `maxConcurrentTasks: 1` is intentional — register
 * is single-writer on `refs/heads/main` and parallel skill-author tasks would
 * compete to fast-forward the same ref.
 */
export async function ensureSkillsCodingRepo(
  deps: EnsureSkillsCodingRepoDeps,
  args: EnsureSkillsCodingRepoArgs,
): Promise<EnsureSkillsCodingRepoResult> {
  const remoteUrl = await readOriginUrl(args.skillsRepoPath);

  if (!remoteUrl) {
    log.warn(
      { localPath: args.skillsRepoPath },
      "skills bare repo has no `origin` configured — `delegate_coding({repo:'skills'})` " +
        "will fail until the wizard or `cogmo migrate-skills-remote` runs",
    );
    return { kind: "skipped_no_origin", localPath: args.skillsRepoPath };
  }

  return deps.runInTx(async (tx) => {
    const existing = await deps.codingStore.getRepoByName(tx, SKILLS_CODING_REPO_NAME);
    if (existing) {
      if (existing.remoteUrl === remoteUrl) {
        return {
          kind: "unchanged",
          name: existing.name,
          localPath: existing.localPath,
          remoteUrl: existing.remoteUrl,
        };
      }
      await deps.codingStore.updateRepoRemoteUrl(tx, existing.id, remoteUrl);
      log.info(
        { name: existing.name, previousRemoteUrl: existing.remoteUrl, remoteUrl },
        "synced skills coding_repos.remote_url from bare repo origin",
      );
      return {
        kind: "updated",
        name: existing.name,
        localPath: existing.localPath,
        remoteUrl,
        previousRemoteUrl: existing.remoteUrl,
      };
    }
    const row = await deps.codingStore.insertRepo(tx, {
      name: SKILLS_CODING_REPO_NAME,
      localPath: args.skillsRepoPath,
      defaultBranch: "main",
      remoteUrl,
      devcontainer: null,
      allowedBackends: ["claude"],
      verifyCommand: "true",
      taskTokenBudget: 200_000,
      taskWallTimeSeconds: 1800,
      maxConcurrentTasks: 1,
    });
    log.info(
      { name: row.name, localPath: row.localPath, remoteUrl },
      "registered skills coding_repos row",
    );
    return { kind: "created", name: row.name, localPath: row.localPath, remoteUrl: row.remoteUrl };
  });
}
