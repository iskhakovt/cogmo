import { err, ok, type Result } from "neverthrow";
import { type LockfileCompiler, type LockfileSnapshot, readLockfileAtSha } from "../deps.js";
import type { SkillManifest } from "../types.js";

/**
 * Read the committed `requirements.lock` at a deploy sha and — when a
 * compiler is configured — re-resolve the manifest's dependencies
 * against `uv pip compile` to verify the committed lockfile is
 * current.
 *
 * Returns:
 *   - `ok(null)` — manifest declares no deps; no lockfile is expected
 *     and any committed `requirements.lock` is ignored.
 *   - `ok(snapshot)` — manifest declares deps and a non-empty lockfile is
 *     present. When a compiler is configured, fresh resolver output
 *     byte-matches the committed file. `snapshot.hash` is `sha256(contents)`.
 *   - `err(message)` — manifest declares deps and one of: the
 *     committed lockfile is missing/empty, the resolver couldn't run
 *     ('transport_failed'), the resolver itself failed
 *     ('resolver_failed'), or the committed file is stale relative
 *     to a fresh resolve. The caller surfaces the message verbatim
 *     as the register `errors[]` payload.
 *
 * When `compiler` is undefined OR `verifyFresh` is false,
 * verification degrades to presence + hash only — the committed
 * file is trusted as-is. `verifyFresh: false` is the rollback
 * mode: the target lockfile was valid at deploy time, hashes are
 * still pinned, and a wheel yanked from PyPI since shouldn't block
 * the operator from rewinding to a known-good revision.
 *
 * Aborting `signal` stops the compile, which then errs as `transport_failed`.
 */
export async function readManifestLockfile(
  compiler: LockfileCompiler | undefined,
  repoPath: string,
  gitSha: string,
  manifest: SkillManifest,
  opts: { verifyFresh: boolean; signal?: AbortSignal } = { verifyFresh: true },
): Promise<Result<LockfileSnapshot | null, string>> {
  if (manifest.dependencies.length === 0) {
    return ok(null);
  }
  const snapshot = await readLockfileAtSha(repoPath, gitSha);
  if (snapshot.isErr()) {
    return err(
      `requirements_lock_${snapshot.error.kind}: declared ${manifest.dependencies.length} dependencies but ${snapshot.error.message}. Run 'uv pip compile --generate-hashes --no-header' and commit the result.`,
    );
  }

  if (opts.verifyFresh && compiler) {
    const compiled = await compiler.compile(manifest.dependencies, {
      ...(opts.signal && { signal: opts.signal }),
    });
    if (compiled.isErr()) {
      return err(`requirements_lock_${compiled.error.kind}: ${compiled.error.message}`);
    }
    if (compiled.value !== snapshot.value.contents) {
      return err(
        "requirements_lock_stale: committed requirements.lock differs from a fresh 'uv pip compile --generate-hashes --no-header'. Re-run the compile against your declared dependencies and recommit.",
      );
    }
  }

  return ok({ hash: snapshot.value.hash, contents: snapshot.value.contents });
}
