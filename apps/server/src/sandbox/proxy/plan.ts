/**
 * Turns a classified route into what reaches the daemon, after the checks
 * its route class needs (design/sandbox.md → Proxy Design → Route table):
 * ownership of the container it names, an exec id created through this
 * task's socket, or a body policy. Each outcome other than a forward is a
 * `ProxyRejection`. The HTTP edge runs the plan.
 */

import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { applyContainerCreatePolicy } from "./create-policy.js";
import { applyExecPolicy } from "./exec-policy.js";
import type { Forward } from "./forward.js";
import { applyNetworkEndpointPolicy, type NetworkEndpoint } from "./network-endpoint.js";
import { type OwnershipLookups, ownedContainer, ownedContainers } from "./ownership.js";
import { notFound, type ProxyRejection } from "./rejection.js";
import { withQuery } from "./request-path.js";
import type { ContainerTarget, ExecTarget, RequestRoute, StreamRoute } from "./router.js";
import type { DaemonLookups, TaskScope } from "./types.js";

export interface StreamContext extends OwnershipLookups {
  /** The exec ids the daemon created through this task's socket. */
  execIds: ReadonlySet<string>;
}

export interface RequestContext extends StreamContext {
  scope: TaskScope;
  /** The daemon reads the container create policy needs. */
  createLookups: DaemonLookups;
  /** The request body, bounded; read only by a route with a body policy. */
  readBody(): Promise<Result<Buffer, ProxyRejection>>;
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
    .with({ kind: "container_create" }, ({ versionPrefix }) =>
      planContainerCreate(versionPrefix, query, ctx),
    )
    .with({ kind: "exec_create" }, ({ ref, versionPrefix }) =>
      planExecCreate({ ref, versionPrefix }, query, ctx),
    )
    .with({ kind: "network_endpoint" }, (endpoint) => planNetworkEndpoint(endpoint, query, ctx))
    .exhaustive();
}

/** The path a stream route replays its request line under. */
export function planStream(
  route: StreamRoute,
  query: URLSearchParams,
  ctx: StreamContext,
): Promise<Result<string, ProxyRejection>> {
  return match(route)
    .with({ kind: "plain" }, async ({ path }) => ok(withQuery(path, query)))
    .with({ kind: "container" }, ({ target }) => containerPath(target, query, ctx))
    .with({ kind: "exec" }, async ({ target }) => execPath(target, query, ctx.execIds))
    .exhaustive();
}

async function planContainerCreate(
  versionPrefix: string,
  query: URLSearchParams,
  ctx: RequestContext,
): Promise<Result<Forward, ProxyRejection>> {
  const body = await ctx.readBody();
  if (body.isErr()) return err(body.error);
  const created = await applyContainerCreatePolicy(
    { body: body.value, query },
    ctx.scope,
    ctx.createLookups,
  );
  return created.map((forward) =>
    rebuilt(withQuery(`${versionPrefix}/containers/create`, forward.query), forward.body),
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
      body: { kind: "rebuilt", bytes: body.value },
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
  execIds: ReadonlySet<string>,
): Result<string, ProxyRejection> {
  return execIds.has(target.id)
    ? ok(withQuery(`${target.versionPrefix}/exec/${target.id}${target.suffix}`, query))
    : err(notFound(`No such exec instance: ${target.id}`));
}

function piped(path: string): Forward {
  return { path, body: { kind: "piped" }, response: { kind: "piped" } };
}

function rebuilt(path: string, bytes: Buffer): Forward {
  return { path, body: { kind: "rebuilt", bytes }, response: { kind: "piped" } };
}
