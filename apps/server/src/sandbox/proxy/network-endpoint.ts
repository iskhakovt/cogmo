/**
 * `POST /networks/{id}/connect` and `/disconnect` (design/sandbox.md → Proxy
 * Design → Route table, Networks). Until tasks own networks, the only
 * network a task may attach a container to or detach one from is the
 * default `bridge`, identified by its resolved id rather than its name: the
 * testcontainers port forwarder names it by id. The body's `Container` must
 * be a container the task owns, at any depth, and is rewritten to its full
 * id. A connect body may set `EndpointConfig.Aliases` only, a disconnect
 * body `Force`.
 */

import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { NetworkConnectBodySchema, NetworkDisconnectBodySchema } from "./body-schemas.js";
import { parseBody } from "./key-rules.js";
import { type OwnershipLookups, ownedContainer } from "./ownership.js";
import { denied, type ProxyRejection, unavailable } from "./rejection.js";
import type { RefLookups } from "./types.js";

export interface NetworkEndpoint {
  /** The network ref as sent. */
  network: string;
  op: "connect" | "disconnect";
  versionPrefix: string;
}

/** The path and body to forward in place of the request's. */
export async function applyNetworkEndpointPolicy(
  endpoint: NetworkEndpoint,
  raw: Buffer,
  lookups: OwnershipLookups,
): Promise<Result<{ path: string; body: Buffer }, ProxyRejection>> {
  const route = `POST /networks/{id}/${endpoint.op}`;
  const body = parseEndpointBody(endpoint.op, raw);
  if (body.isErr()) return err(body.error);
  const network = await bridgeId(endpoint.network, lookups.refs, route);
  if (network.isErr()) return err(network.error);
  const container = await ownedContainer(lookups, {
    ref: body.value.Container,
    depth: "any",
    route,
  });
  return container.map((owned) => ({
    path: `${endpoint.versionPrefix}/networks/${network.value}/${endpoint.op}`,
    body: Buffer.from(JSON.stringify({ ...body.value, Container: owned.dockerId }), "utf8"),
  }));
}

function parseEndpointBody(
  op: NetworkEndpoint["op"],
  raw: Buffer,
): Result<{ Container: string }, ProxyRejection> {
  return match(op)
    .with("connect", () => parseBody(raw, NetworkConnectBodySchema))
    .with("disconnect", () => parseBody(raw, NetworkDisconnectBodySchema))
    .exhaustive();
}

/**
 * `bridge`'s full id, when `ref` resolves to it. A ref to any other network,
 * or to none, is `denied`, so a missing network and another task's get the
 * same answer.
 */
async function bridgeId(
  ref: string,
  refs: RefLookups,
  route: string,
): Promise<Result<string, ProxyRejection>> {
  const [requested, bridge] = await Promise.all([
    refs.resolveNetwork(ref),
    refs.resolveNetwork("bridge"),
  ]);
  if (bridge.isErr()) {
    return err(
      match(bridge.error)
        .with({ kind: "not_found" }, () => unavailable("the daemon has no bridge network"))
        .with({ kind: "unavailable" }, (failure) => failure)
        .exhaustive(),
    );
  }
  const onlyBridge = denied(`${route} on a network other than bridge`);
  return requested.match(
    (id) => (id === bridge.value ? ok(id) : err(onlyBridge)),
    (failure) =>
      err(
        match(failure)
          .with({ kind: "not_found" }, () => onlyBridge)
          .with({ kind: "unavailable" }, (unreachable) => unreachable)
          .exhaustive(),
      ),
  );
}
