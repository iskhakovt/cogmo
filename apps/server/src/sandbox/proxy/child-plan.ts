/**
 * The plans for a child's create, start and removal (design/sandbox.md →
 * Proxy Design → Child containers): each forward carries the store write
 * that follows the daemon's answer, so the child's row tracks what the
 * task did to it.
 */

import { err, ok, type Result } from "neverthrow";
import type { CreateForward } from "./create-forward.js";
import { applyContainerCreatePolicy } from "./create-policy.js";
import type { Forward } from "./forward.js";
import {
  type OwnedContainers,
  type OwnershipLookups,
  ownedContainer,
  ownedContainers,
} from "./ownership.js";
import { denied, type ProxyRejection } from "./rejection.js";
import { withQuery } from "./request-path.js";
import type { ContainerTarget } from "./router.js";
import type { ChildRecord, DaemonLookups, TaskContainerRow, TaskScope } from "./types.js";

/**
 * The live children a task may hold: rows at depth ≥ 1 in `starting` or
 * `running`. The count is read before the forward, so two concurrent
 * creates can land one past it, which is benign at single-user scale
 * (store-pattern.md → admission caps).
 */
const MAX_LIVE_CHILDREN = 16;

/** The daemon's answers to a start that leaves the container running: started, or already running. */
const STARTED_STATUSES: ReadonlySet<number> = new Set([204, 304]);
const REMOVED_STATUS = 204;

export interface ChildContext extends OwnershipLookups {
  scope: TaskScope;
  /** The daemon reads the container create policy needs. */
  createLookups: DaemonLookups;
  /** The request body, bounded; read only by a route with a body policy. */
  readBody(): Promise<Result<Buffer, ProxyRejection>>;
  /** Insert a created child's row; `record_failed` once its container is gone. */
  recordChild(child: ChildRecord): Promise<Result<void, ProxyRejection>>;
  /**
   * Follow a child's start in its row. `not_found`, naming `ref`, when the
   * row had finished meanwhile and the container has been removed.
   */
  childStarted(child: TaskContainerRow, ref: string): Promise<Result<void, ProxyRejection>>;
  /** Follow a child's removal in its row. */
  childRemoved(child: TaskContainerRow): Promise<void>;
}

/**
 * A create, under its policy and the child cap, with the row its 201 gets:
 * the task's depth-0 row as parent, the task's lineage and TTL, and the
 * limits the policy injected or capped.
 */
export async function planContainerCreate(
  versionPrefix: string,
  query: URLSearchParams,
  ctx: ChildContext,
): Promise<Result<CreateForward, ProxyRejection>> {
  const body = await ctx.readBody();
  if (body.isErr()) return err(body.error);
  const created = await applyContainerCreatePolicy(
    { body: body.value, query },
    ctx.scope,
    ctx.createLookups,
  );
  if (created.isErr()) return err(created.error);
  const { scope } = ctx;
  const owned = (await ownedContainers(ctx)).andThen(withinChildCap);
  return owned.map(({ task }) => {
    const child: Omit<ChildRecord, "dockerId"> = {
      ...created.value.child,
      parentId: task.id,
      rootTaskId: scope.taskId,
      depth: scope.parentDepth + 1,
      runtime: scope.runtime,
      ttlExpiresAt: scope.ttlExpiresAt,
      instanceId: scope.instanceId,
    };
    return {
      path: withQuery(`${versionPrefix}/containers/create`, created.value.query),
      body: created.value.body,
      record: (dockerId) => ctx.recordChild({ ...child, dockerId }),
    };
  });
}

function withinChildCap(owned: OwnedContainers): Result<OwnedContainers, ProxyRejection> {
  return owned.liveChildren >= MAX_LIVE_CHILDREN
    ? err(denied(`a container create past the task's ${MAX_LIVE_CHILDREN} live children`))
    : ok(owned);
}

/**
 * A child's start, sent with no body: a body is the `HostConfig` of API
 * versions before 1.24, which the daemon refuses past seven bytes and
 * ignores below that. Once the daemon has started the child, its row moves
 * to `running`.
 */
export async function planChildStart(
  target: ContainerTarget,
  query: URLSearchParams,
  ctx: ChildContext,
): Promise<Result<Forward, ProxyRejection>> {
  const body = await ctx.readBody();
  if (body.isErr()) return err(body.error);
  if (body.value.length > 0) return err(denied(`a body on ${target.route}`));
  const owned = await ownedContainer(ctx, target);
  return owned.map(
    (child): Forward => ({
      path: withQuery(
        `${target.versionPrefix}/containers/${child.dockerId}${target.suffix}`,
        query,
      ),
      body: { kind: "none" },
      response: {
        kind: "child_transition",
        settle: async (status) =>
          STARTED_STATUSES.has(status) ? ctx.childStarted(child, target.ref) : ok(undefined),
      },
    }),
  );
}

/**
 * A child's removal, which takes its anonymous volumes with it (`v=true`).
 * `link` is denied: with it the daemon removes a legacy link and leaves the
 * container. Once the daemon has removed the child, its row moves to
 * `exited`.
 */
export async function planChildRemove(
  target: ContainerTarget,
  query: URLSearchParams,
  ctx: ChildContext,
): Promise<Result<Forward, ProxyRejection>> {
  if (query.has("link")) return err(denied(`the link query key on ${target.route}`));
  const owned = await ownedContainer(ctx, target);
  const forwarded = new URLSearchParams(query);
  forwarded.set("v", "true");
  return owned.map(
    (child): Forward => ({
      path: withQuery(
        `${target.versionPrefix}/containers/${child.dockerId}${target.suffix}`,
        forwarded,
      ),
      body: { kind: "none" },
      response: {
        kind: "child_transition",
        settle: async (status) => {
          if (status === REMOVED_STATUS) await ctx.childRemoved(child);
          return ok(undefined);
        },
      },
    }),
  );
}
