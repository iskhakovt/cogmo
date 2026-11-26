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
import { type OwnershipLookups, ownedContainer, ownedContainers } from "./ownership.js";
import { denied, type ProxyRejection, unavailable } from "./rejection.js";
import { withQuery } from "./request-path.js";
import type { ContainerTarget } from "./router.js";
import type {
  ChildRecord,
  DaemonLookups,
  TaskAnchor,
  TaskContainerRow,
  TaskScope,
} from "./types.js";

/** The daemon's answers to a start that leaves the container running: started, or already running. */
const STARTED_STATUSES: ReadonlySet<number> = new Set([204, 304]);
const RESTARTED_STATUS = 204;
const REMOVED_STATUS = 204;

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
  /** Insert a created child's row within `deadline`; a rejection once its container is gone. */
  recordChild(child: ChildRecord, deadline: AbortSignal): Promise<Result<void, ProxyRejection>>;
  /**
   * Follow a child's start in its row. `not_found`, naming `ref`, when a
   * reap finished the row meanwhile and the container has been removed.
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
  const { scope } = ctx;
  const anchor = anchorOf(scope);
  if (anchor.isErr()) return err(anchor.error);
  const body = await ctx.readBody();
  if (body.isErr()) return err(body.error);
  // The task's own row is read before the policy's daemon lookups: with no
  // live row there is nothing to look anything up for.
  const owned = await ownedContainers(ctx);
  if (owned.isErr()) return err(owned.error);
  const created = await applyContainerCreatePolicy(
    { body: body.value, query },
    { scope, anchor: anchor.value },
    ctx.createLookups,
  );
  if (created.isErr()) return err(created.error);
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
      record: (dockerId, deadline) => ctx.recordChild({ ...child, dockerId }, deadline),
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
 * alone included, is denied. Once the daemon has started the child, its
 * row moves to `running`.
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
 * A child's restart, forwarded with no body: the daemon reads only its
 * query (`t`, `signal`), and a half-sent body could otherwise hold the
 * daemon request open. A restart the daemon answers 204 has left the child
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
        query,
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
 * the child, its row moves to `exited`.
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
          if (status === REMOVED_STATUS) await ctx.childRemoved(child);
          return ok(undefined);
        },
      },
    }),
  );
}

/** No body is zero bytes; whitespace alone is a body, and not JSON. */
function isEmptyStartBody(body: Buffer): boolean {
  if (body.length === 0) return true;
  try {
    return EmptyStartBodySchema.safeParse(JSON.parse(body.toString("utf8"))).success;
  } catch {
    // Not JSON, so not one of the bodies that mean nothing.
    return false;
  }
}

/**
 * A query value as moby's `httputils.BoolValue` reads it: absent, or one
 * of its false values after trimming and lower-casing, is false; anything
 * else is true. The daemon reads a key's first value, as `get` does.
 */
function formTrue(value: string | null): boolean {
  return value !== null && !FALSE_FORM_VALUES.has(value.trim().toLowerCase());
}
