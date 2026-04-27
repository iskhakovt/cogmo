/**
 * Endpoint classification for the Docker socket proxy.
 *
 * Pure module — given a method + path, decides what to do. Three outcomes:
 *
 * - **deny** — wholesale block. Returns 403 to the caller.
 * - **policy** — buffer the request body and run policy mutation. Currently
 *   `POST /containers/create` only.
 * - **hijack** — the endpoint upgrades to a raw bidirectional stream
 *   (`/exec/{id}/start`, `/containers/{id}/attach`, `/events`, `/build`,
 *   `/session`, log follow). Caller pipes the upgraded sockets in both
 *   directions and stays out of the way.
 * - **forward** — plain HTTP/1.1 round-trip to the upstream daemon socket,
 *   no body inspection.
 *
 * References for the endpoint set:
 *   buildkite/sockguard, CpuID/dockerd-ci-proxy, Tecnativa/docker-socket-proxy.
 */

export type RouteOutcome =
  | { kind: "deny"; status: number; reason: string }
  | { kind: "policy"; subject: "container_create" }
  | { kind: "hijack" }
  | { kind: "forward" };

/** Match `/containers/{id}/<action>` capturing the Docker container id. */
const CONTAINER_ACTION_RE =
  /^\/(?:v[\d.]+\/)?containers\/[^/]+\/(attach|start|stop|kill|restart|wait|logs|exec)(\?|$|\/)/;

const EXEC_START_RE = /^\/(?:v[\d.]+\/)?exec\/[^/]+\/start(\?|$)/;

/** Endpoints whose response is a stream that long-polls or upgrades. */
const STREAMING_GET_RE =
  /^\/(?:v[\d.]+\/)?(?:events|session|build|distribution\/[^/]+\/json)(\?|$)/;

/** Endpoint families denied wholesale — admin surfaces a non-orchestrator must never touch. */
const DENY_PREFIXES: readonly string[] = ["/swarm", "/plugins", "/nodes"];

/**
 * Classify a request. Strips the optional `/v1.NN/` API-version prefix before
 * matching so callers can use either prefixed (`/v1.43/containers/create`) or
 * unprefixed (`/containers/create`) paths interchangeably.
 */
export function classify(method: string, rawPath: string): RouteOutcome {
  const path = stripQuery(rawPath);
  const upper = method.toUpperCase();

  for (const prefix of DENY_PREFIXES) {
    if (matchesPrefix(path, prefix)) {
      return { kind: "deny", status: 403, reason: `${prefix}/* is blocked by Cogmo proxy` };
    }
  }

  // POST /containers/create — body inspection + label/runtime/cgroup injection.
  if (upper === "POST" && pathMatches(path, "/containers/create")) {
    return { kind: "policy", subject: "container_create" };
  }

  // Hijacked: `/exec/{id}/start` upgrades to raw bytes once Docker accepts.
  if (upper === "POST" && EXEC_START_RE.test(rawPath)) {
    return { kind: "hijack" };
  }

  // `/containers/{id}/attach` — same hijack mechanism as exec/start.
  if (upper === "POST" && /\/(?:v[\d.]+\/)?containers\/[^/]+\/attach(\?|$)/.test(rawPath)) {
    return { kind: "hijack" };
  }

  // GET /containers/{id}/logs?follow=1 — long-polled stream. Without follow,
  // it's a normal short response; classify them both as hijack so the same
  // pipe handler covers both (it works equally well for short responses).
  if (upper === "GET" && /\/(?:v[\d.]+\/)?containers\/[^/]+\/logs(\?|$)/.test(rawPath)) {
    return { kind: "hijack" };
  }

  if (upper === "GET" && STREAMING_GET_RE.test(rawPath)) {
    return { kind: "hijack" };
  }

  // POST /build — long-running, NDJSON progress stream. Pipe both directions.
  if (upper === "POST" && pathMatches(path, "/build")) {
    return { kind: "hijack" };
  }

  // POST /session — BuildKit upgrades HTTP/1.1 → HTTP/2 (gRPC). Same raw-pipe
  // treatment; we don't speak HTTP/2 inside the proxy.
  if (upper === "POST" && pathMatches(path, "/session")) {
    return { kind: "hijack" };
  }

  // Pass-through everything else: `/_ping`, `/version`, `/info`,
  // `/containers/json`, `/containers/{id}/json`, `/images/*`, `/networks/*`
  // (with policy on `POST /networks/create` etc. layered in later sub-PRs),
  // `/volumes/*`, `/auth`, `/system/df`, …
  // The other /containers/{id}/<action> calls flow through too — slice 3
  // doesn't authz them yet (the per-task socket itself is the boundary;
  // 3.0f wires the docker-id ownership map).
  void CONTAINER_ACTION_RE;
  return { kind: "forward" };
}

function stripQuery(rawPath: string): string {
  const q = rawPath.indexOf("?");
  return q === -1 ? rawPath : rawPath.slice(0, q);
}

/** True if `path` equals or starts with `prefix` (segment-aware). */
function matchesPrefix(path: string, prefix: string): boolean {
  // Strip optional API version prefix.
  const stripped = path.replace(/^\/v[\d.]+/, "");
  return stripped === prefix || stripped.startsWith(`${prefix}/`);
}

function pathMatches(path: string, target: string): boolean {
  const stripped = path.replace(/^\/v[\d.]+/, "");
  return stripped === target;
}
