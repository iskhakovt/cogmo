import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { logger } from "../logger.js";

const execFileP = promisify(execFile);
const log = logger.child({ component: "skills.repo" });

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

const PRE_RECEIVE_HOOK = `#!/usr/bin/env bash
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
