/**
 * Admission for a `delegate_coding` submission: recover the task a retry
 * already inserted, or admit a new one against the repo's concurrency cap.
 */

import type { Transaction } from "../../db/index.js";
import type { CodingRepoRow, CodingStore, CodingTaskRow } from "./store/index.js";

type AdmitOutcome =
  | { kind: "admitted"; task: CodingTaskRow }
  /** Same idempotency key as a prior attempt, which already inserted the task. */
  | { kind: "recovered"; task: CodingTaskRow }
  | { kind: "rejected"; active: number };

/**
 * Runs inside the caller's transaction, so the count and the insert share a
 * snapshot. A retry is recognised before the admission count: the row it is
 * recovering counts against the repo's own limit, so with the default
 * `maxConcurrentTasks` of 1 it would reject itself.
 *
 * REPEATABLE READ doesn't predicate-lock, so two concurrent submissions can
 * each see `active < limit` and both insert. At single-user scale that
 * residual is accepted; multi-tenant would want an advisory lock taken before
 * the snapshot, not SERIALIZABLE (see `.claude/rules/store-pattern.md`).
 * `SELECT ... FOR UPDATE` on the repo row would not help: the winner never
 * updates that row, so the loser's count still reads its earlier snapshot.
 */
export async function admitCodingTask(
  tx: Transaction,
  store: CodingStore,
  args: {
    repo: CodingRepoRow;
    conversationId: string;
    goal: string;
    idempotencyKey: string | undefined;
  },
): Promise<AdmitOutcome> {
  const { repo, idempotencyKey } = args;
  if (idempotencyKey !== undefined) {
    const prior = await store.getTaskByIdempotencyKey(tx, idempotencyKey);
    if (prior) {
      // A scope check, not an expected case: the key embeds a
      // conversation-scoped inbound id, so a cross-repo hit means the key
      // space itself is broken.
      assertSameRepo(prior, repo, idempotencyKey);
      return { kind: "recovered", task: prior };
    }
  }
  const active = await store.countActiveTasksForRepo(tx, repo.id);
  if (active >= repo.maxConcurrentTasks) {
    return { kind: "rejected", active };
  }
  const values = {
    repoId: repo.id,
    conversationId: args.conversationId,
    goal: args.goal,
    triggerSource: "user" as const,
    backend: "claude" as const,
    allowPrivilegedRunc: false,
  };
  if (idempotencyKey === undefined) {
    return { kind: "admitted", task: await store.insertTask(tx, values) };
  }
  // The conflict arm closes the window the pre-check leaves open: two
  // concurrent retries can both read no row under snapshot isolation, and
  // the loser recovers the winner's row rather than raising a unique
  // violation. It is also the path that can surface a foreign row, since it
  // resolves against a row the pre-check's snapshot could not see.
  const insert = await store.insertOrRecoverTask(tx, { ...values, idempotencyKey });
  assertSameRepo(insert.row, repo, idempotencyKey);
  return insert.kind === "new"
    ? { kind: "admitted", task: insert.row }
    : { kind: "recovered", task: insert.row };
}

function assertSameRepo(task: CodingTaskRow, repo: CodingRepoRow, idempotencyKey: string): void {
  if (task.repoId !== repo.id) {
    throw new Error(
      `idempotency key ${idempotencyKey} resolves to a task on a different repo ` +
        `(${task.repoId} vs ${repo.id}) — key space collision`,
    );
  }
}
