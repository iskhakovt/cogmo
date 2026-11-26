/**
 * Container ownership (design/sandbox.md → Proxy Design → Ownership). A
 * task owns the `containers` rows that carry its `root_task_id` and are not
 * `reaped`, read from the store on every request. A ref is resolved through
 * the daemon to its full id and checked against those rows; the caller
 * forwards the full id, so a rename between the check and the forward
 * cannot redirect the request.
 *
 * A ref the task does not own, whether a sibling's container, one of
 * Cogmo's own or one that does not exist, gets the daemon's 404 wording.
 */

import { err, ok, type Result, type ResultAsync } from "neverthrow";
import { match } from "ts-pattern";
import { denied, notFound, type ProxyRejection, unavailable } from "./rejection.js";
import type { DepthRule } from "./router.js";
import type { OwnedContainer, RefLookups } from "./types.js";

export interface OwnershipLookups {
  /** The task's rows, `unavailable` when the store read failed. */
  ownedRows(): ResultAsync<ReadonlyArray<OwnedContainer>, ProxyRejection>;
  refs: RefLookups;
}

/**
 * The task's rows, once its depth-0 row exists: before the supervisor has
 * recorded the task container, nothing the task asks about can be checked.
 */
export async function liveOwnedRows(
  lookups: OwnershipLookups,
): Promise<Result<ReadonlyArray<OwnedContainer>, ProxyRejection>> {
  const rows = await lookups.ownedRows();
  return rows.andThen((owned) =>
    owned.some((row) => row.depth === 0)
      ? ok(owned)
      : err(unavailable("the task container has no row yet")),
  );
}

/**
 * The owned container `ref` resolves to. `depth: "child"` denies the task's
 * own depth-0 container, naming `route`.
 */
export async function ownedContainer(
  lookups: OwnershipLookups,
  target: { ref: string; depth: DepthRule; route: string },
): Promise<Result<OwnedContainer, ProxyRejection>> {
  const rows = await liveOwnedRows(lookups);
  if (rows.isErr()) return err(rows.error);
  const resolved = await lookups.refs.resolveContainer(target.ref);
  return resolved.andThen((dockerId): Result<OwnedContainer, ProxyRejection> => {
    const row = rows.value.find((r) => r.dockerId === dockerId);
    if (row === undefined) return err(notFound(`No such container: ${target.ref}`));
    return match(target.depth)
      .with("any", () => ok(row))
      .with("child", () =>
        row.depth === 0 ? err(denied(`${target.route} on the task's own container`)) : ok(row),
      )
      .exhaustive();
  });
}
