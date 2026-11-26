/**
 * The child cap (design/sandbox.md → Proxy Design → Caps and cost): a task
 * holds at most 16 live children, counting its rows at depth ≥ 1 in
 * `starting` or `running` and its creates admitted on this socket and not
 * yet settled on any of the task's sockets, a retiring one's included, an
 * admission whose child's row the read returned counting once, as the row. A create that finds the count at 16 first has the
 * task's live children reconciled against the daemon, so `docker run --rm`
 * children, which remove themselves with no `DELETE` through the proxy, do
 * not fill it until the reaper's next stale pass.
 *
 * The count and the admission are one synchronous step, so concurrent
 * creates on one socket cannot each land past the cap. What remains is a
 * create whose store read began before another's insert committed and
 * whose decision comes after that create settled: at most one past the cap
 * per such race, which is benign at single-user scale (store-pattern.md →
 * admission caps).
 */

import { err, type Result } from "neverthrow";
import type { CreateAdmission, CreateTracker } from "./in-flight-creates.js";
import { denied, type ProxyRejection } from "./rejection.js";
import type { TaskContainerRow } from "./types.js";

const MAX_LIVE_CHILDREN = 16;

export interface ChildCapContext {
  /** This socket's admitted creates. */
  creates: Pick<CreateTracker, "admittedBeyond" | "admit" | "admitting">;
  /** The live children the daemon still has; one it no longer has moves to `exited`. */
  reconcileChildren(
    children: ReadonlyArray<TaskContainerRow>,
  ): Promise<Result<ReadonlyArray<TaskContainerRow>, ProxyRejection>>;
}

/**
 * Admit a create if the task has room for one more live child, reconciling
 * first when it would not. Once the socket's teardown has begun, the answer
 * is `unavailable` whether or not there is room, as it is for any request.
 */
export async function admitWithinCap(
  liveChildren: ReadonlyArray<TaskContainerRow>,
  ctx: ChildCapContext,
): Promise<Result<CreateAdmission, ProxyRejection>> {
  if (hasRoom(liveChildren, ctx)) return ctx.creates.admit();
  const admitting = ctx.creates.admitting();
  if (admitting.isErr()) return err(admitting.error);
  const reconciled = await ctx.reconcileChildren(liveChildren);
  return reconciled.andThen((live) =>
    hasRoom(live, ctx)
      ? ctx.creates.admit()
      : ctx.creates
          .admitting()
          .andThen(() =>
            err(denied(`a container create past the task's ${MAX_LIVE_CHILDREN} live children`)),
          ),
  );
}

function hasRoom(live: ReadonlyArray<TaskContainerRow>, ctx: ChildCapContext): boolean {
  const counted = new Set(live.map((row) => row.dockerId));
  return live.length + ctx.creates.admittedBeyond(counted) < MAX_LIVE_CHILDREN;
}
