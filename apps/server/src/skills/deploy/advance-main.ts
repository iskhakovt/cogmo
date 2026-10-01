import { err, ok, type Result } from "neverthrow";
import type { Transaction, Transactor } from "../../db/index.js";
import { getMainSha, isAncestor, RefMovedError, updateRef } from "../git-ops.js";
import { ZERO_SHA } from "./deploy-deps.js";

/**
 * What `main` must look like for a deploy to move it:
 * - `fast_forward`: main precedes the new tip (register, approve);
 * - `unchanged`: main still holds the sha the deploy checked before its
 *   transaction (rollback, which rewinds main and would otherwise discard
 *   a deploy that landed in between).
 */
export type MainGuard = { kind: "fast_forward" } | { kind: "unchanged"; expected: string | null };

/** Thrown inside a deploy transaction to roll it back when main moved. */
class MainMovedError extends Error {
  constructor() {
    super("skills main moved during a deploy");
    this.name = "MainMovedError";
  }
}

/**
 * Move `refs/heads/main` to `newSha` from a deploy transaction's
 * `applyFilesystem`. Main is read here, under the per-skill advisory lock,
 * but that lock is per skill name and main is shared: a deploy of any other
 * skill may have moved it since the checks before the transaction, and may
 * still move it between this read and `update-ref`. The guard catches the
 * first, the compare-and-swap the second; either throws to roll the
 * transaction back, and {@link runDeployTx} turns that into `main_moved`.
 * Returns the sha main held.
 */
export async function advanceMain(
  repoPath: string,
  newSha: string,
  guard: MainGuard,
): Promise<string | null> {
  const mainSha = await getMainSha(repoPath);
  const holds =
    guard.kind === "fast_forward"
      ? mainSha === null || (await isAncestor(repoPath, mainSha, newSha))
      : mainSha === guard.expected;
  if (!holds) throw new MainMovedError();
  try {
    await updateRef(repoPath, "refs/heads/main", newSha, mainSha ?? ZERO_SHA);
  } catch (e) {
    throw e instanceof RefMovedError ? new MainMovedError() : e;
  }
  return mainSha;
}

/** Why a deploy transaction rolled back without a database-side outcome. */
export type DeployTxFailure = { kind: "main_moved" };

/**
 * Run a deploy transaction whose `applyFilesystem` calls {@link advanceMain},
 * erring with `main_moved` when it rolled back for that reason.
 */
export async function runDeployTx<T>(
  runInTx: Transactor,
  execute: (tx: Transaction) => Promise<T>,
): Promise<Result<T, DeployTxFailure>> {
  try {
    return ok(await runInTx(execute));
  } catch (e) {
    if (e instanceof MainMovedError) return err({ kind: "main_moved" });
    throw e;
  }
}
