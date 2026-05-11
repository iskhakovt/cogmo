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
 * Read `origin` URL from a bare repo's git config. Returns `""` if no remote
 * is set. Any other git failure is propagated — silently swallowing it would
 * mask a misconfigured repo as "no remote", which is a worse failure mode
 * than crashing the boot.
 */
async function readOriginUrl(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoPath, "remote", "get-url", "origin"]);
    return stdout.trim();
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? "";
    // git exits with code 2 + "No such remote 'origin'" when the remote is
    // unset — the normal state for a fresh bare repo with no user-configured
    // backup remote. Treat as empty string; surface anything else.
    if (/no such remote/i.test(stderr)) return "";
    throw e;
  }
}

export interface EnsureSkillsCodingRepoResult {
  /** True iff this call inserted the row; false iff a row was already present. */
  created: boolean;
  /** The repo's `name` (always `SKILLS_CODING_REPO_NAME` — exposed for log clarity). */
  name: string;
  /** Resolved local path on disk. */
  localPath: string;
  /** Resolved `origin` URL at insert time (empty string if no remote is configured). */
  remoteUrl: string;
}

export interface EnsureSkillsCodingRepoDeps {
  runInTx: Transactor;
  codingStore: CodingStore;
}

export interface EnsureSkillsCodingRepoArgs {
  skillsRepoPath: string;
}

/**
 * Idempotently ensure a `coding_repos` row exists for the skill library. The
 * filesystem half is bootstrapped by {@link bootstrapSkillsRepo}; this is the
 * DB half — without it, `delegate_coding({ repo: "skills" })` throws "Repo
 * not registered: skills" even though the bare repo is present on disk and
 * every config knob has an obvious default.
 *
 * `remote_url` is read from the bare repo's `origin` config — so an operator
 * who attaches a GitHub/Gitea remote via `git remote add origin …` doesn't
 * have to re-enter the URL. Future changes to that remote do not propagate
 * (this row is insert-once); a future `/repo edit` flow or operator SQL is
 * the path for mutating it.
 *
 * Defaults match the per-repo knobs that `Transport.repos.add` already uses
 * for user-added repos. `maxConcurrentTasks: 1` is intentional — register is
 * single-writer on `refs/heads/main` and parallel skill-author tasks would
 * compete to fast-forward the same ref.
 */
export async function ensureSkillsCodingRepo(
  deps: EnsureSkillsCodingRepoDeps,
  args: EnsureSkillsCodingRepoArgs,
): Promise<EnsureSkillsCodingRepoResult> {
  const remoteUrl = await readOriginUrl(args.skillsRepoPath);

  return deps.runInTx(async (tx) => {
    const existing = await deps.codingStore.getRepoByName(tx, SKILLS_CODING_REPO_NAME);
    if (existing) {
      return {
        created: false,
        name: existing.name,
        localPath: existing.localPath,
        remoteUrl: existing.remoteUrl,
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
    return { created: true, name: row.name, localPath: row.localPath, remoteUrl: row.remoteUrl };
  });
}
