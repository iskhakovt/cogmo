import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { err, ok, type Result } from "neverthrow";
import { describeError } from "../util/describe-error.js";

const execFileP = promisify(execFile);

/** A ref, branch or sha that does not resolve in the repo. */
export interface RefNotFound {
  kind: "ref_not_found";
  ref: string;
}

/** A path absent from a commit that does exist. */
export interface FileNotFound {
  kind: "file_not_found";
  sha: string;
  file: string;
}

export type GitShowError = RefNotFound | FileNotFound;

function stderrOf(e: unknown): string {
  return typeof e === "object" && e !== null && "stderr" in e && typeof e.stderr === "string"
    ? e.stderr
    : "";
}

function exitCodeOf(e: unknown): unknown {
  return typeof e === "object" && e !== null && "code" in e ? e.code : undefined;
}

/**
 * A git invocation that failed for a reason no caller handles: git missing,
 * the repo unreadable, a corrupt object. Thrown, since nothing but a human
 * repairs it.
 */
/** `update-ref`'s compare-and-swap failed: the ref no longer holds the expected sha. */
export class RefMovedError extends Error {
  constructor(ref: string, expectedOldSha: string | undefined, cause: unknown) {
    super(`ref ${ref} changed since read (expected ${expectedOldSha})`, { cause });
    this.name = "RefMovedError";
  }
}

function gitFailure(what: string, e: unknown): Error {
  return new Error(`git ${what} failed: ${describeError(e)}`, { cause: e });
}

/**
 * Resolve a ref (branch, tag, sha-prefix) to a full 40-char SHA. Errs with
 * `ref_not_found` when the ref is unknown.
 */
export async function revParse(
  repoPath: string,
  ref: string,
): Promise<Result<string, RefNotFound>> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoPath, "rev-parse", "--verify", ref]);
    return ok(stdout.trim());
  } catch (e) {
    if (
      /unknown revision|bad revision|Needed a single revision|invalid object name/.test(stderrOf(e))
    ) {
      return err({ kind: "ref_not_found", ref });
    }
    throw gitFailure("rev-parse", e);
  }
}

/**
 * Read a file's contents at a specific commit. The bare repo has no working
 * copy, so every read goes through `git show <sha>:<path>`. A missing path
 * (`file_not_found`) is told apart from a missing commit (`ref_not_found`).
 */
export async function gitShow(
  repoPath: string,
  sha: string,
  file: string,
): Promise<Result<string, GitShowError>> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoPath, "show", `${sha}:${file}`], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return ok(stdout);
  } catch (e) {
    const stderr = stderrOf(e);
    if (/exists on disk, but not in|does not exist/.test(stderr)) {
      return err({ kind: "file_not_found", sha, file });
    }
    if (/unknown revision|bad revision|invalid object name/.test(stderr)) {
      return err({ kind: "ref_not_found", ref: sha });
    }
    throw gitFailure("show", e);
  }
}

/**
 * Returns true when `ancestor` is an ancestor of `descendant`. Used to enforce
 * fast-forward semantics on register / rollback.
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
    if (exitCodeOf(e) === 1) return false;
    throw gitFailure("merge-base --is-ancestor", e);
  }
}

/**
 * Atomically advance a ref to a new SHA, optionally checking the current SHA
 * matches `expectedOldSha` (CAS — `git update-ref`'s third positional argument).
 * Pass the zero SHA for `expectedOldSha` when creating the ref; pass
 * `undefined` to skip the CAS check.
 *
 * `git update-ref` is the only ref-mutation path that bypasses the
 * `pre-receive` hook installed by `bootstrapSkillsRepo` — so this is the
 * single mechanism by which Cogmo advances `refs/heads/main`.
 *
 * Throws {@link RefMovedError} when the CAS check fails: the deploy transactions call this last,
 * inside the transaction, and the throw is what rolls them back.
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
    if (/cannot lock ref|is at .* but expected/.test(stderrOf(e))) {
      throw new RefMovedError(ref, expectedOldSha, e);
    }
    throw gitFailure("update-ref", e);
  }
}

/**
 * Delete a branch (any non-main ref). Used by `register` after merging a
 * feature branch into main — the audit trail lives on `skill_deploys.git_sha`.
 * No-op if the ref doesn't exist.
 *
 * Refuses `refs/heads/main` (or bare `main`): `main` is only advanced via
 * {@link updateRef}, never deleted, and a caller computing that name has a bug.
 */
export async function deleteRef(repoPath: string, ref: string): Promise<void> {
  if (ref === "main" || ref === "refs/heads/main") {
    throw new Error(
      "deleteRef refuses to delete refs/heads/main — main is advanced via updateRef only",
    );
  }
  try {
    await execFileP("git", ["-C", repoPath, "update-ref", "-d", ref]);
  } catch (e) {
    if (/no ref|does not exist/.test(stderrOf(e))) return;
    throw gitFailure("update-ref -d", e);
  }
}

/**
 * Returns the SHA of `refs/heads/main` if it exists, else null. The bare repo
 * has no main on first boot — every register past that returns a SHA.
 */
export async function getMainSha(repoPath: string): Promise<string | null> {
  return (await revParse(repoPath, "refs/heads/main")).unwrapOr(null);
}
