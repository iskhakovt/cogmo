/**
 * The plans for a child's create, start, restart and removal (design/sandbox.md →
 * Proxy Design → Child containers): each forward carries the store write
 * that follows the daemon's answer, so the child's row tracks what the
 * task did to it.
 */

import { err, ok, type Result } from "neverthrow";
import { match, P } from "ts-pattern";
import { z } from "zod";
import { admitWithinCap, type ChildCapContext } from "./child-cap.js";
import type { CreateForward } from "./create-forward.js";
import { applyContainerCreatePolicy } from "./create-policy.js";
import type { Forward } from "./forward.js";
import { parseJson } from "./key-rules.js";
import { type OwnershipLookups, ownedContainer, ownedContainers } from "./ownership.js";
import { denied, type ProxyRejection, unavailable } from "./rejection.js";
import { onlyKeys, withQuery } from "./request-path.js";
import type { ContainerTarget } from "./router.js";
import type {
  ChildRecord,
  ChildRemovalCause,
  DaemonLookups,
  TaskAnchor,
  TaskContainerRow,
  TaskScope,
} from "./types.js";

/** The daemon's answers to a start that leaves the container running: started, or already running. */
const STARTED_STATUSES: ReadonlySet<number> = new Set([204, 304]);
const RESTARTED_STATUS = 204;

/**
 * The query keys the daemon documents for a start and a restart; no other
 * key is forwarded. A start's undocumented `checkpoint` and
 * `checkpoint-dir` would restore the container from a checkpoint under a
 * host path.
 */
const START_KEYS: ReadonlySet<string> = new Set(["detachKeys"]);
const RESTART_KEYS: ReadonlySet<string> = new Set(["t", "signal"]);
/** The daemon's answers to a removal that leave no container: removed, or already gone. */
const REMOVAL_CAUSES: ReadonlyMap<number, ChildRemovalCause> = new Map([
  [204, "removed_by_task"],
  [404, "missing_from_daemon"],
]);

/**
 * The start bodies forwarded, with no body: `null` and `{}`, which clients
 * send (the Ruby docker-api client sends `{}`, dockerode JSON once options
 * are set) and the daemon reads as nothing.
 */
const EmptyStartBodySchema = z.union([z.null(), z.strictObject({})]);

/** The form values moby's `httputils.BoolValue` reads as false, after trimming and lower-casing. */
const FALSE_FORM_VALUES: ReadonlySet<string> = new Set(["", "0", "no", "false", "none"]);

export interface ChildContext extends OwnershipLookups, ChildCapContext {
  scope: TaskScope;
  /** The daemon reads the container create policy needs. */
  createLookups: DaemonLookups;
  /** The request body, bounded; read only by a route with a body policy. */
  readBody(): Promise<Result<Buffer, ProxyRejection>>;
  /** Insert a created child's row unless `cutOff` aborts first; a rejection once it failed or was cut off. */
  recordChild(child: ChildRecord, cutOff: AbortSignal): Promise<Result<void, ProxyRejection>>;
  /**
   * Follow a child's start in its row. `not_found`, naming `ref`, when a
   * reap finished the row meanwhile and the container has been removed.
   */
  childStarted(child: TaskContainerRow, ref: string): Promise<Result<void, ProxyRejection>>;
  /** Follow in its row a child's container gone through its `DELETE`. */
  childRemoved(child: TaskContainerRow, cause: ChildRemovalCause): Promise<void>;
}

/**
 * A create, under its policy and the child cap, with the row its 201 gets:
 * the task's depth-0 row as parent, the task's lineage and TTL, and the
 * limits the policy injected or capped. Once the socket's teardown has
 * begun, a create its checks refuse is `unavailable`, as one they pass is
 * (design/sandbox.md → Teardown order).
 */
export async function planContainerCreate(
  versionPrefix: string,
  query: URLSearchParams,
  ctx: ChildContext,
): Promise<Result<CreateForward, ProxyRejection>> {
  const planned = await planCreate(versionPrefix, query, ctx);
  return planned.orElse((rejection) =>
    ctx.creates.admitting().andThen(() => err<CreateForward, ProxyRejection>(rejection)),
  );
}

async function planCreate(
  versionPrefix: string,
  query: URLSearchParams,
  ctx: ChildContext,
): Promise<Result<CreateForward, ProxyRejection>> {
  const { scope } = ctx;
  const anchor = anchorOf(scope);
  if (anchor.isErr()) return err(anchor.error);
  const body = await ctx.readBody();
  if (body.isErr()) return err(body.error);
  // The task's own row is read before the policy's daemon lookups: with no
  // live row there is nothing to look anything up for.
  const before = await ownedContainers(ctx);
  if (before.isErr()) return err(before.error);
  const created = await applyContainerCreatePolicy(
    { body: body.value, query },
    { scope, anchor: anchor.value },
    ctx.createLookups,
  );
  if (created.isErr()) return err(created.error);
  // The rows are read again for the cap, after those lookups: a create
  // that settled while this one inspected its image is counted as its row.
  const owned = await ownedContainers(ctx);
  if (owned.isErr()) return err(owned.error);
  const admitted = await admitWithinCap(owned.value.liveChildren, ctx);
  return admitted.map((admission) => {
    const child: Omit<ChildRecord, "dockerId"> = {
      ...created.value.child,
      parentId: owned.value.task.id,
      rootTaskId: scope.taskId,
      depth: scope.parentDepth + 1,
      runtime: scope.runtime,
      ttlExpiresAt: scope.ttlExpiresAt,
      instanceId: scope.instanceId,
    };
    return {
      path: withQuery(`${versionPrefix}/containers/create`, created.value.query),
      body: created.value.body,
      record: (dockerId, cutOff) => ctx.recordChild({ ...child, dockerId }, cutOff),
      admission,
    };
  });
}

/** The task's depth-0 container, which a child's labels and row name; none before its row exists. */
function anchorOf(scope: TaskScope): Result<TaskAnchor, ProxyRejection> {
  return match(scope.anchor)
    .with(
      null,
      (): Result<TaskAnchor, ProxyRejection> =>
        err(unavailable("the task container has no live row")),
    )
    .with(P.nonNullable, (anchor) => ok(anchor))
    .exhaustive();
}

/**
 * A child's start, sent with no body. A body is the `HostConfig` of API
 * versions before 1.24, which the daemon refuses past seven bytes: `null`
 * and `{}` mean nothing and are accepted, and anything else, whitespace
 * alone included, is denied. Only `detachKeys` goes in the query. Once the
 * daemon has started the child, its row moves to `running`.
 */
export async function planChildStart(
  target: ContainerTarget,
  query: URLSearchParams,
  ctx: ChildContext,
): Promise<Result<Forward, ProxyRejection>> {
  const body = await ctx.readBody();
  if (body.isErr()) return err(body.error);
  if (!isEmptyStartBody(body.value)) return err(denied(`a body on ${target.route}`));
  const owned = await ownedContainer(ctx, target);
  return owned.map(
    (child): Forward => ({
      path: withQuery(
        `${target.versionPrefix}/containers/${child.dockerId}${target.suffix}`,
        onlyKeys(query, START_KEYS),
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
 * A child's restart, forwarded with no body and only `t` and `signal` in
 * its query, which is all the daemon reads: a half-sent body could
 * otherwise hold the daemon request open. A restart the daemon answers 204 has left the child
 * running, so its row moves as a start's.
 */
export async function planChildRestart(
  target: ContainerTarget,
  query: URLSearchParams,
  ctx: ChildContext,
): Promise<Result<Forward, ProxyRejection>> {
  const owned = await ownedContainer(ctx, target);
  return owned.map(
    (child): Forward => ({
      path: withQuery(
        `${target.versionPrefix}/containers/${child.dockerId}${target.suffix}`,
        onlyKeys(query, RESTART_KEYS),
      ),
      body: { kind: "none" },
      response: {
        kind: "child_transition",
        settle: async (status) =>
          status === RESTARTED_STATUS ? ctx.childStarted(child, target.ref) : ok(undefined),
      },
    }),
  );
}

/**
 * A child's removal, which takes its anonymous volumes with it (`v=true`).
 * A true `link` is denied: with it the daemon removes a legacy link and
 * leaves the container. A false one, which docker-py and
 * testcontainers-python send, is forwarded. Once the daemon has removed
 * the child, or answers 404 for one already gone, its row moves to
 * `exited`.
 */
export async function planChildRemove(
  target: ContainerTarget,
  query: URLSearchParams,
  ctx: ChildContext,
): Promise<Result<Forward, ProxyRejection>> {
  if (formTrue(query.get("link"))) return err(denied(`a true link on ${target.route}`));
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
          const cause = REMOVAL_CAUSES.get(status);
          if (cause !== undefined) await ctx.childRemoved(child, cause);
          return ok(undefined);
        },
      },
    }),
  );
}

/**
 * No body is zero bytes; whitespace alone is a body, and not JSON. A body
 * that is not JSON is not one of the bodies that mean nothing.
 */
function isEmptyStartBody(body: Buffer): boolean {
  if (body.length === 0) return true;
  return parseJson(body)
    .map((value) => EmptyStartBodySchema.safeParse(value).success)
    .unwrapOr(false);
}

/**
 * A query value as moby's `httputils.BoolValue` reads it: absent, or one
 * of its false values after trimming and lower-casing, is false; anything
 * else is true. The daemon reads a key's first value, as `get` does.
 */
function formTrue(value: string | null): boolean {
  return value !== null && !FALSE_FORM_VALUES.has(value.trim().toLowerCase());
}
