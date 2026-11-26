/**
 * Turns a classified route into what reaches the daemon, after the checks
 * its route class needs (design/sandbox.md → Proxy Design → Route table):
 * ownership of the container it names, an exec id created through this
 * task's socket, or a body policy; a child's create, start and removal are
 * planned in `child-plan.ts`. Each outcome other than a forward is a
 * `ProxyRejection`. The HTTP edge runs the plan.
 */

import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import {
  type ChildContext,
  planChildRemove,
  planChildRestart,
  planChildStart,
} from "./child-plan.js";
import type { ExecIdLookup } from "./exec-ids.js";
import { applyExecPolicy } from "./exec-policy.js";
import type { Forward } from "./forward.js";
import { imageCreateQuery } from "./image-create-query.js";
import { applyNetworkEndpointPolicy, type NetworkEndpoint } from "./network-endpoint.js";
import { type OwnershipLookups, ownedContainer, ownedContainers } from "./ownership.js";
import { notFound, type ProxyRejection } from "./rejection.js";
import { withQuery } from "./request-path.js";
import type { ContainerTarget, ExecTarget, RequestRoute, StreamRoute } from "./router.js";

export interface StreamContext extends OwnershipLookups {
  /** The exec ids the daemon created through this task's socket. */
  execIds: ExecIdLookup;
}

export interface RequestContext extends StreamContext, ChildContext {
  /** Add an exec id the daemon created through this task's socket. */
  recordExec(execId: string): void;
}

export function planRequest(
  route: RequestRoute,
  query: URLSearchParams,
  ctx: RequestContext,
): Promise<Result<Forward, ProxyRejection>> {
  return match(route)
    .with({ kind: "plain" }, async ({ path }) => ok(piped(withQuery(path, query))))
    .with({ kind: "image_create" }, async ({ versionPrefix }) =>
      planImageCreate(versionPrefix, query),
    )
    .with({ kind: "container" }, async ({ target }) =>
      (await containerPath(target, query, ctx)).map(piped),
    )
    .with({ kind: "exec" }, async ({ target }) => execPath(target, query, ctx.execIds).map(piped))
    .with({ kind: "container_list" }, async ({ path }) =>
      (await ownedContainers(ctx)).map(
        ({ all }): Forward => ({
          path: withQuery(path, query),
          body: { kind: "piped" },
          response: { kind: "container_list", owned: new Set(all.map((r) => r.dockerId)) },
        }),
      ),
    )
    .with({ kind: "events" }, async ({ path }) =>
      (await ownedContainers(ctx)).map(
        ({ task }): Forward => ({
          path: withQuery(path, query),
          body: { kind: "piped" },
          response: { kind: "events", taskContainerId: task.dockerId },
        }),
      ),
    )
    .with({ kind: "child_start" }, ({ target }) => planChildStart(target, query, ctx))
    .with({ kind: "child_restart" }, ({ target }) => planChildRestart(target, query, ctx))
    .with({ kind: "child_remove" }, ({ target }) => planChildRemove(target, query, ctx))
    .with({ kind: "exec_create" }, ({ ref, versionPrefix }) =>
      planExecCreate({ ref, versionPrefix }, query, ctx),
    )
    .with({ kind: "network_endpoint" }, (endpoint) => planNetworkEndpoint(endpoint, query, ctx))
    .exhaustive();
}

/**
 * The path a stream route's request goes to: the request line an upgrade
 * replays, or the path of a request without `Upgrade`, which is forwarded
 * as any other route is (`streamForward`).
 */
export function planStream(
  route: StreamRoute,
  query: URLSearchParams,
  ctx: StreamContext,
): Promise<Result<string, ProxyRejection>> {
  return match(route)
    .with({ kind: "container" }, ({ target }) => containerPath(target, query, ctx))
    .with({ kind: "exec" }, async ({ target }) => execPath(target, query, ctx.execIds))
    .exhaustive();
}

/**
 * A pull, forwarded with no body. The daemon reads this route's parameters
 * with `ParseForm`, where a form body's values override the query's, so a
 * body could turn the checked pull into an import. docker-modem sends every
 * POST's options as a JSON body as well as the query, so a pull with a body
 * is normal: the body is drained and dropped, and the daemon reads the
 * checked query alone.
 */
function planImageCreate(
  versionPrefix: string,
  query: URLSearchParams,
): Result<Forward, ProxyRejection> {
  return imageCreateQuery(query).map(
    (forwarded): Forward => ({
      path: withQuery(`${versionPrefix}/images/create`, forwarded),
      body: { kind: "none" },
      response: { kind: "piped" },
    }),
  );
}

/** The body's checks run before any daemon lookup, as on a container create. */
async function planExecCreate(
  target: { ref: string; versionPrefix: string },
  query: URLSearchParams,
  ctx: RequestContext,
): Promise<Result<Forward, ProxyRejection>> {
  const body = (await ctx.readBody()).andThen(applyExecPolicy);
  if (body.isErr()) return err(body.error);
  const owned = await ownedContainer(ctx, {
    ref: target.ref,
    depth: "any",
    route: "POST /containers/{id}/exec",
  });
  return owned.map(
    (container): Forward => ({
      path: withQuery(`${target.versionPrefix}/containers/${container.dockerId}/exec`, query),
      body: { kind: "json", bytes: body.value },
      response: { kind: "exec_created", record: ctx.recordExec },
    }),
  );
}

async function planNetworkEndpoint(
  endpoint: NetworkEndpoint,
  query: URLSearchParams,
  ctx: RequestContext,
): Promise<Result<Forward, ProxyRejection>> {
  const body = await ctx.readBody();
  if (body.isErr()) return err(body.error);
  const applied = await applyNetworkEndpointPolicy(endpoint, body.value, ctx);
  return applied.map((forward) => rebuilt(withQuery(forward.path, query), forward.body));
}

async function containerPath(
  target: ContainerTarget,
  query: URLSearchParams,
  lookups: OwnershipLookups,
): Promise<Result<string, ProxyRejection>> {
  const owned = await ownedContainer(lookups, target);
  return owned.map((container) =>
    withQuery(`${target.versionPrefix}/containers/${container.dockerId}${target.suffix}`, query),
  );
}

/**
 * An exec id is accepted only if this task's socket created it. The ids in
 * the set are the daemon's own 64-character hex ids, safe in a path.
 */
function execPath(
  target: ExecTarget,
  query: URLSearchParams,
  execIds: ExecIdLookup,
): Result<string, ProxyRejection> {
  return execIds.has(target.id)
    ? ok(withQuery(`${target.versionPrefix}/exec/${target.id}${target.suffix}`, query))
    : err(notFound(`No such exec instance: ${target.id}`));
}

/** A stream route's request without `Upgrade`, forwarded under the path `planStream` gave. */
export function streamForward(path: string): Forward {
  return piped(path);
}

function piped(path: string): Forward {
  return { path, body: { kind: "piped" }, response: { kind: "piped" } };
}

function rebuilt(path: string, bytes: Buffer): Forward {
  return {
    path,
    body: { kind: "json", bytes },
    response: { kind: "piped" },
  };
}
