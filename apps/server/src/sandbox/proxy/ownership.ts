/**
 * Container ownership (design/sandbox.md → Proxy Design → Ownership). A
 * task owns its scope's own depth-0 row, the one whose id is
 * `TaskScope.parentContainerRowId`, and that row's children, read from the
 * store on every request. The task's `root_task_id` alone does not decide
 * it: coding teardown's salvage containers carry it at depth 0 too, and one
 * of them mounts the PAT. A ref is resolved through the daemon to its full
 * id and checked against the owned rows; the caller forwards the full id,
 * so a rename between the check and the forward cannot redirect the
 * request.
 *
 * A ref the task does not own, whether a sibling's container, one of
 * Cogmo's own or one that does not exist, gets the daemon's 404 wording.
 */

import { err, ok, type Result, type ResultAsync } from "neverthrow";
import { match } from "ts-pattern";
import { denied, notFound, type ProxyRejection, unavailable } from "./rejection.js";
import type { DepthRule } from "./router.js";
import type { RefLookups, TaskContainerRow } from "./types.js";

export interface OwnershipLookups {
  /** The rows that carry the task's `root_task_id` and are not `reaped`; `unavailable` when the store read failed. */
  taskRows(): ResultAsync<ReadonlyArray<TaskContainerRow>, ProxyRejection>;
  /** The scope's own depth-0 row, `TaskScope.parentContainerRowId`; `null` before it exists. */
  taskContainerRowId: string | null;
  refs: RefLookups;
}

export interface OwnedContainers {
  /** The scope's depth-0 row. */
  task: TaskContainerRow;
  /** That row and its children. */
  all: ReadonlyArray<TaskContainerRow>;
  /**
   * The task's rows at depth ≥ 1 in `starting` or `running`, whichever
   * depth-0 row they hang from: what the child cap counts.
   */
  liveChildren: number;
}

/**
 * The containers the task owns, once its own depth-0 row exists and is not
 * `reaped`: before the supervisor has recorded the task container, or after
 * it is reaped, nothing the task asks about can be checked.
 */
export async function ownedContainers(
  lookups: OwnershipLookups,
): Promise<Result<OwnedContainers, ProxyRejection>> {
  const { taskContainerRowId } = lookups;
  if (taskContainerRowId === null) return err(noLiveRow());
  const rows = await lookups.taskRows();
  return rows.andThen((candidates) => {
    const task = candidates.find((row) => row.id === taskContainerRowId);
    if (task === undefined) return err(noLiveRow());
    const all = candidates.filter((row) => row.id === task.id || row.parentId === task.id);
    const liveChildren = candidates.filter((row) => row.parentId !== null && isLive(row)).length;
    return ok({ task, all, liveChildren });
  });
}

function noLiveRow(): ProxyRejection {
  return unavailable("the task container has no live row");
}

function isLive(row: TaskContainerRow): boolean {
  return match(row.status)
    .with("starting", "running", () => true)
    .with("exited", () => false)
    .exhaustive();
}

/**
 * The owned container `ref` resolves to. `depth: "child"` denies the task's
 * own depth-0 container, naming `route`.
 */
export async function ownedContainer(
  lookups: OwnershipLookups,
  target: { ref: string; depth: DepthRule; route: string },
): Promise<Result<TaskContainerRow, ProxyRejection>> {
  const owned = await ownedContainers(lookups);
  if (owned.isErr()) return err(owned.error);
  const { task, all } = owned.value;
  const resolved = await lookups.refs.resolveContainer(target.ref);
  return resolved.andThen((dockerId): Result<TaskContainerRow, ProxyRejection> => {
    const row = all.find((r) => r.dockerId === dockerId);
    if (row === undefined) return err(notFound(`No such container: ${target.ref}`));
    return match(target.depth)
      .with("any", () => ok(row))
      .with("child", () =>
        row.id === task.id ? err(denied(`${target.route} on the task's own container`)) : ok(row),
      )
      .exhaustive();
  });
}

/**
 * A ref from a request body, which unlike a path ref has not been
 * canonicalised, as the ref to resolve. One leading `/` goes, since a name
 * is printed that way (`docker inspect`'s `.Name`). An empty, `.` or `..`
 * segment would move the inspect it goes into to another path, and names
 * no container.
 */
export function checkBodyRef(ref: string): Result<string, ProxyRejection> {
  const name = ref.startsWith("/") ? ref.slice(1) : ref;
  const unclean = name.split("/").some((s) => s === "" || s === "." || s === "..");
  return unclean ? err(notFound(`No such container: ${ref}`)) : ok(name);
}
