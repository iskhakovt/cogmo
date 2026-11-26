/**
 * The route table (design/sandbox.md → Proxy Design → Route table). Pure:
 * given a method and request target, it names the route and what its
 * checks need, or the rejection. The first matching row wins, and a path
 * no row matches is `denied`, so a route the daemon adds later stays
 * closed until it is listed.
 *
 * The patterns mirror the daemon's router (`daemon/server/router/*` in
 * moby): a `{name:.*}` there spans segments, so `(.+)` here does too. A
 * legacy link names a container `/parent/alias`, and an exec id or image
 * name may hold a `/`.
 *
 * A **request** route goes through `http.request`, its response streaming
 * back. A **stream** route, exec start or attach, may be upgraded: an
 * upgrade is raw-piped once its checks pass, and a request without
 * `Upgrade` goes through `http.request` as any other route does, so a
 * request pipelined after it is classified on its own. A container
 * **create** is a request whose daemon answer the proxy reads and records
 * before it answers, bound to neither the client nor the task's sockets.
 */

import { match } from "ts-pattern";
import { denied, type ProxyRejection } from "./rejection.js";
import { encodePath, parseTarget } from "./request-path.js";

/**
 * Whether a container route accepts the task's own depth-0 container.
 * Lifecycle routes and archive writes need a child: the task container's
 * lifecycle is Cogmo's, and its `/workspace` is a host bind.
 */
export type DepthRule = "any" | "child";

export interface ContainerTarget {
  /** The ref as sent: a full id, a unique id prefix or a name. */
  ref: string;
  versionPrefix: string;
  /** The route after the container id: `/json`, `/archive`, or `""` for a `DELETE`. */
  suffix: string;
  depth: DepthRule;
  /** The route class, `POST /containers/{id}/stop`, for a rejection message. */
  route: string;
}

export interface ExecTarget {
  /** The exec id as sent. */
  id: string;
  versionPrefix: string;
  /** `/start`, `/resize` or `/json`. */
  suffix: string;
}

export type RequestRoute =
  /** Forwarded without an ownership check: the meta routes, and image, network and volume routes until their policies land. */
  | { kind: "plain"; path: string }
  | { kind: "container"; target: ContainerTarget }
  /** A child's `start`, whose row follows the daemon's answer. */
  | { kind: "child_start"; target: ContainerTarget }
  /** A child's `DELETE`, whose row follows the daemon's answer. */
  | { kind: "child_remove"; target: ContainerTarget }
  /** `POST /images/create`, under its query policy. */
  | { kind: "image_create"; versionPrefix: string }
  | { kind: "exec_create"; ref: string; versionPrefix: string }
  | { kind: "exec"; target: ExecTarget }
  | { kind: "container_list"; path: string }
  | { kind: "events"; path: string }
  | {
      kind: "network_endpoint";
      network: string;
      op: "connect" | "disconnect";
      versionPrefix: string;
    };

export type StreamRoute =
  | { kind: "container"; target: ContainerTarget }
  | { kind: "exec"; target: ExecTarget };

export type Classified =
  | { kind: "reject"; rejection: ProxyRejection }
  | { kind: "request"; route: RequestRoute; query: URLSearchParams }
  | { kind: "stream"; route: StreamRoute; query: URLSearchParams }
  /** `POST /containers/create`. */
  | { kind: "create"; versionPrefix: string; query: URLSearchParams };

type Outcome =
  | { kind: "reject"; rejection: ProxyRejection }
  | { kind: "request"; route: RequestRoute }
  | { kind: "stream"; route: StreamRoute }
  | { kind: "create"; versionPrefix: string };

interface Row {
  method: string;
  pattern: RegExp;
  outcome: (groups: ReadonlyArray<string>, versionPrefix: string, route: string) => Outcome;
}

const LIFECYCLE_ACTIONS = "kill|pause|unpause|restart|stop|rename";

/** A row forwarded under its canonical path with no ownership check. */
function plainRow(method: string, pattern: RegExp): Row {
  return {
    method,
    pattern,
    outcome: (_, v, r) => request({ kind: "plain", path: canonical(v, r) }),
  };
}

/** A container route that accepts any owned container, the task's own included. */
function readRow(method: string, pattern: RegExp): Row {
  return {
    method,
    pattern,
    outcome: (g, v) => request({ kind: "container", target: container(method, "any", g, v) }),
  };
}

/** Rows in the daemon's own order within each method. */
const ROWS: ReadonlyArray<Row> = [
  // Meta
  plainRow("GET", /^\/_ping$/),
  plainRow("HEAD", /^\/_ping$/),
  plainRow("GET", /^\/version$/),
  plainRow("GET", /^\/info$/),
  {
    method: "GET",
    pattern: /^\/events$/,
    outcome: (_, v, r) => request({ kind: "events", path: canonical(v, r) }),
  },
  // Containers
  readRow("HEAD", /^\/containers\/(.+)\/(archive)$/),
  {
    method: "GET",
    pattern: /^\/containers\/json$/,
    outcome: (_, v, r) => request({ kind: "container_list", path: canonical(v, r) }),
  },
  readRow("GET", /^\/containers\/(.+)\/(export|changes|json|top|logs|stats|archive)$/),
  {
    method: "GET",
    pattern: /^\/containers\/(.+)\/(attach\/ws)$/,
    outcome: (g, v) => stream({ kind: "container", target: container("GET", "any", g, v) }),
  },
  {
    method: "GET",
    pattern: /^\/exec\/(.+)\/(json)$/,
    outcome: (g, v) => request({ kind: "exec", target: exec(g, v) }),
  },
  {
    method: "POST",
    pattern: /^\/containers\/create$/,
    outcome: (_, v) => ({ kind: "create", versionPrefix: v }),
  },
  {
    method: "POST",
    pattern: /^\/containers\/(.+)\/(start)$/,
    outcome: (g, v) => request({ kind: "child_start", target: container("POST", "child", g, v) }),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/containers/(.+)/(${LIFECYCLE_ACTIONS})$`),
    outcome: (g, v) => request({ kind: "container", target: container("POST", "child", g, v) }),
  },
  readRow("POST", /^\/containers\/(.+)\/(wait|resize)$/),
  {
    method: "POST",
    pattern: /^\/containers\/(.+)\/(attach)$/,
    outcome: (g, v) => stream({ kind: "container", target: container("POST", "any", g, v) }),
  },
  {
    method: "POST",
    pattern: /^\/containers\/(.+)\/exec$/,
    outcome: (g, v) => request({ kind: "exec_create", ref: nth(g, 0), versionPrefix: v }),
  },
  {
    method: "POST",
    pattern: /^\/exec\/(.+)\/(start)$/,
    outcome: (g, v) => stream({ kind: "exec", target: exec(g, v) }),
  },
  {
    method: "POST",
    pattern: /^\/exec\/(.+)\/(resize)$/,
    outcome: (g, v) => request({ kind: "exec", target: exec(g, v) }),
  },
  {
    method: "PUT",
    pattern: /^\/containers\/(.+)\/(archive)$/,
    outcome: (g, v) => request({ kind: "container", target: container("PUT", "child", g, v) }),
  },
  // The daemon's checkpoint router, registered ahead of the container
  // router, takes this path with single-segment `{name}` and `{checkpoint}`.
  {
    method: "DELETE",
    pattern: /^\/containers\/[^/]+\/checkpoints\/[^/]+$/,
    outcome: () => ({
      kind: "reject",
      rejection: denied("DELETE /containers/{id}/checkpoints/{checkpoint}"),
    }),
  },
  {
    method: "DELETE",
    pattern: /^\/containers\/(.+)$/,
    outcome: (g, v) =>
      request({ kind: "child_remove", target: container("DELETE", "child", g, v) }),
  },
  // Images
  plainRow("GET", /^\/images\/json$/),
  plainRow("GET", /^\/images\/(.+)\/(history|json)$/),
  {
    method: "POST",
    pattern: /^\/images\/create$/,
    outcome: (_, v) => request({ kind: "image_create", versionPrefix: v }),
  },
  plainRow("GET", /^\/distribution\/(.+)\/json$/),
  // Networks
  plainRow("GET", /^\/networks$/),
  plainRow("GET", /^\/networks\/(.+)$/),
  plainRow("POST", /^\/networks\/create$/),
  networkEndpointRow("connect"),
  networkEndpointRow("disconnect"),
  plainRow("DELETE", /^\/networks\/(.+)$/),
  // Volumes
  plainRow("GET", /^\/volumes$/),
  plainRow("GET", /^\/volumes\/(.+)$/),
  plainRow("POST", /^\/volumes\/create$/),
  {
    method: "DELETE",
    pattern: /^\/volumes\/(.+)$/,
    outcome: () => ({ kind: "reject", rejection: denied("DELETE /volumes/{name}") }),
  },
];

/** Classify a request by the first row its method and canonical route match. */
export function classify(method: string, rawTarget: string): Classified {
  const parsed = parseTarget(rawTarget);
  if (parsed.isErr()) return { kind: "reject", rejection: parsed.error };
  const { versionPrefix, route, query } = parsed.value;
  const upper = method.toUpperCase();
  const row = ROWS.find((r) => r.method === upper && r.pattern.test(route));
  if (row === undefined) return { kind: "reject", rejection: denied(`${upper} ${route}`) };
  const groups = row.pattern.exec(route)?.slice(1) ?? [];
  return match(row.outcome(groups, versionPrefix, route))
    .with({ kind: "reject" }, (outcome) => outcome)
    .with({ kind: "request" }, ({ route: r }) => ({ kind: "request" as const, route: r, query }))
    .with({ kind: "stream" }, ({ route: r }) => ({ kind: "stream" as const, route: r, query }))
    .with({ kind: "create" }, ({ versionPrefix: v }) => ({
      kind: "create" as const,
      versionPrefix: v,
      query,
    }))
    .exhaustive();
}

function networkEndpointRow(op: "connect" | "disconnect"): Row {
  return {
    method: "POST",
    pattern: new RegExp(`^/networks/(.+)/${op}$`),
    outcome: (g, versionPrefix) =>
      request({ kind: "network_endpoint", network: nth(g, 0), op, versionPrefix }),
  };
}

function canonical(versionPrefix: string, route: string): string {
  return `${versionPrefix}${encodePath(route)}`;
}

function container(
  method: string,
  depth: DepthRule,
  groups: ReadonlyArray<string>,
  versionPrefix: string,
): ContainerTarget {
  const action = groups[1];
  const suffix = action === undefined ? "" : `/${action}`;
  return {
    ref: nth(groups, 0),
    versionPrefix,
    suffix,
    depth,
    route: `${method} /containers/{id}${suffix}`,
  };
}

function exec(groups: ReadonlyArray<string>, versionPrefix: string): ExecTarget {
  return { id: nth(groups, 0), versionPrefix, suffix: `/${nth(groups, 1)}` };
}

/** A capture group the row's pattern always has. */
function nth(groups: ReadonlyArray<string>, index: number): string {
  const group = groups[index];
  if (group === undefined) throw new Error(`route pattern has no capture group ${index}`);
  return group;
}

function request(route: RequestRoute): Outcome {
  return { kind: "request", route };
}

function stream(route: StreamRoute): Outcome {
  return { kind: "stream", route };
}
