import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export class GitOpsError extends Error {
  readonly code:
    | "ref_not_found"
    | "file_not_found"
    | "non_fast_forward"
    | "ref_changed"
    | "exec_failed";
  constructor(
    code: GitOpsError["code"],
    message: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "GitOpsError";
    this.code = code;
  }
}

/**
 * Resolve a ref (branch, tag, sha-prefix) to a full 40-char SHA. Throws
 * `ref_not_found` if the ref is unknown — used by `register` to verify the
 * branch exists before reading from it.
 */
export async function revParse(repoPath: string, ref: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoPath, "rev-parse", "--verify", ref]);
    return stdout.trim();
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? "";
    if (/unknown revision|bad revision|Needed a single revision|invalid object name/.test(stderr)) {
      throw new GitOpsError("ref_not_found", `ref not found: ${ref}`, stderr);
    }
    throw new GitOpsError("exec_failed", `git rev-parse failed: ${(e as Error).message}`, stderr);
  }
}

/**
 * Read a file's contents at a specific commit. The bare repo doesn't have a
 * working copy, so all reads go through `git show <sha>:<path>`. Throws
 * `file_not_found` if the path doesn't exist at that commit (vs ref_not_found
 * which is a missing commit) so the caller can produce a precise error.
 */
export async function gitShow(repoPath: string, sha: string, file: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoPath, "show", `${sha}:${file}`], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? "";
    if (/exists on disk, but not in|does not exist/.test(stderr)) {
      throw new GitOpsError("file_not_found", `file not found at ${sha}: ${file}`, stderr);
    }
    if (/unknown revision|bad revision|invalid object name/.test(stderr)) {
      throw new GitOpsError("ref_not_found", `ref not found: ${sha}`, stderr);
    }
    throw new GitOpsError("exec_failed", `git show failed: ${(e as Error).message}`, stderr);
  }
}

/**
 * Returns true when `ancestor` is an ancestor of `descendant`. Used to enforce
 * fast-forward semantics on register / rollback. A ref that doesn't exist
 * yet (no prior main) is treated as ancestor of anything.
 */
export async function isAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await execFileP("git", ["-C", repoPath, "merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (e) {
    const exitCode = (e as { code?: number }).code;
    if (exitCode === 1) {
      return false;
    }
    const stderr = (e as { stderr?: string }).stderr ?? "";
    throw new GitOpsError(
      "exec_failed",
      `git merge-base --is-ancestor failed: ${(e as Error).message}`,
      stderr,
    );
  }
}

/**
 * Atomically advance a ref to a new SHA, optionally checking the current SHA
 * matches `expectedOldSha` (CAS — `git update-ref`'s third positional argument).
 * Pass an empty string for `expectedOldSha` when creating the ref for the first
 * time; pass `undefined` to skip the CAS check.
 *
 * `git update-ref` is the only ref-mutation path that bypasses the
 * `pre-receive` hook installed by `bootstrapSkillsRepo` — so this is the
 * single mechanism by which Cogmo advances `refs/heads/main`.
 */
export async function updateRef(
  repoPath: string,
  ref: string,
  newSha: string,
  expectedOldSha?: string,
): Promise<void> {
  const args = ["-C", repoPath, "update-ref", ref, newSha];
  if (expectedOldSha !== undefined) {
    args.push(expectedOldSha);
  }
  try {
    await execFileP("git", args);
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? "";
    if (/cannot lock ref|is at .* but expected/.test(stderr)) {
      throw new GitOpsError(
        "ref_changed",
        `ref ${ref} changed since read (expected ${expectedOldSha})`,
        stderr,
      );
    }
    throw new GitOpsError("exec_failed", `git update-ref failed: ${(e as Error).message}`, stderr);
  }
}

/**
 * Delete a branch (any non-main ref). Used by `register` after merging a
 * feature branch into main — the branch is no longer needed; the audit trail
 * lives on `skill_deploys.git_sha`. No-op if the ref doesn't exist (best-effort
 * cleanup; we don't want to fail the register path on a stale delete).
 *
 * Refuses `refs/heads/main` (or bare `main`) at the boundary — `main` is only
 * advanced via {@link updateRef}, never deleted. Defense in depth against a
 * caller bug computing the wrong branch name (e.g. registering from `main`
 * itself); without this guard, a misuse silently drops the skills repo's only
 * authoritative ref.
 */
export async function deleteRef(repoPath: string, ref: string): Promise<void> {
  if (ref === "main" || ref === "refs/heads/main") {
    throw new GitOpsError(
      "exec_failed",
      "deleteRef refuses to delete refs/heads/main — main is advanced via updateRef only",
    );
  }
  try {
    await execFileP("git", ["-C", repoPath, "update-ref", "-d", ref]);
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? "";
    if (/no ref|does not exist/.test(stderr)) {
      return;
    }
    throw new GitOpsError(
      "exec_failed",
      `git update-ref -d failed: ${(e as Error).message}`,
      stderr,
    );
  }
}

/**
 * Returns the SHA of `refs/heads/main` if it exists, else null. The bare repo
 * has no main on first boot — every register past that returns a SHA.
 */
export async function getMainSha(repoPath: string): Promise<string | null> {
  try {
    return await revParse(repoPath, "refs/heads/main");
  } catch (e) {
    if (e instanceof GitOpsError && e.code === "ref_not_found") {
      return null;
    }
    throw e;
  }
}
