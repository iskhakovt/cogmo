/**
 * Endpoint classification for the Docker socket proxy.
 *
 * Pure module — given a method + path, decides what to do:
 *
 * - **reject** — a `ProxyRejection` the edge answers without contacting the
 *   daemon: a denied endpoint family, or a create or exec create under an
 *   API version below `MIN_API_VERSION`.
 * - **container_create** / **exec_create** — buffer the body and run it
 *   through its policy (`create-policy.ts`, `exec-policy.ts`).
 * - **hijack** — the endpoint upgrades to a raw bidirectional stream
 *   (`/exec/{id}/start`, `/containers/{id}/attach`, `/events`, log follow).
 *   Caller pipes the upgraded sockets in both directions and stays out of
 *   the way.
 * - **forward** — plain HTTP/1.1 round-trip to the upstream daemon socket,
 *   no body inspection.
 *
 * References for the endpoint set:
 *   buildkite/sockguard, CpuID/dockerd-ci-proxy, Tecnativa/docker-socket-proxy.
 */

import { denied, type ProxyRejection } from "./rejection.js";

export type RouteOutcome =
  | { kind: "reject"; rejection: ProxyRejection }
  /** `versionPrefix` is `""` or the request's `/v<version>`, forwarded as is. */
  | { kind: "container_create"; versionPrefix: string }
  | { kind: "exec_create" }
  | { kind: "hijack" }
  | { kind: "forward" };

/**
 * The create and exec policies read their bodies with API 1.44 semantics,
 * so an older version prefix on those two routes is denied. A request with
 * no prefix gets the daemon's own version, which is newer.
 */
const MIN_API_VERSION = "1.44";

const EXEC_CREATE_RE = /^\/containers\/[^/]+\/exec$/;

const EXEC_START_RE = /^\/(?:v[\d.]+\/)?exec\/[^/]+\/start(\?|$)/;

/**
 * Endpoints whose response is a stream that long-polls or upgrades.
 * `/events` is the live container event feed; `/distribution/.../json`
 * is the registry-distribution metadata fetch. `/build` and `/session`
 * are denied wholesale (see `DENY_PREFIXES`) so they don't appear here.
 */
const STREAMING_GET_RE = /^\/(?:v[\d.]+\/)?(?:events|distribution\/[^/]+\/json)(\?|$)/;

/**
 * Endpoint families denied wholesale.
 *
 * - `/swarm`, `/plugins`, `/nodes` — admin surfaces an unprivileged
 *   container has no business touching.
 * - `/build`, `/session` — image production. `/build` lets in-container
 *   code build arbitrary images and push via `--push` / auth headers;
 *   `/session` is BuildKit's gRPC channel which does the same. Until
 *   we have a registry allowlist + BuildKit gRPC inspection (P3 in
 *   `design/sandbox.md`), block both. Local in-container `docker
 *   build` against testcontainers patterns still works because the
 *   common case there is `/containers/create` against a pre-built
 *   image, not `/build`.
 * - `/auth` — populates the daemon's registry-credential cache; a
 *   subsequent `/images/create` (pull) with private images, or any
 *   future `/build --push` if the deny above were ever lifted, would
 *   ride on those creds. Block at the source.
 */
const DENY_PREFIXES: readonly string[] = [
  "/swarm",
  "/plugins",
  "/nodes",
  "/build",
  "/session",
  "/auth",
];

/**
 * Classify a request. Strips the optional `/v1.NN/` API-version prefix before
 * matching so callers can use either prefixed (`/v1.47/containers/json`) or
 * unprefixed (`/containers/json`) paths interchangeably. Canonicalises
 * percent-encoded characters and collapses redundant slashes/dot-segments
 * before any prefix match — otherwise `/v1.43/swarm%2Finit` or `/swarm/./x`
 * would slip past the deny check on raw-string compares.
 */
export function classify(method: string, rawPath: string): RouteOutcome {
  const path = canonicalisePath(stripQuery(rawPath));
  const upper = method.toUpperCase();

  const deniedPrefix = DENY_PREFIXES.find((prefix) => matchesPrefix(path, prefix));
  if (deniedPrefix !== undefined) {
    return { kind: "reject", rejection: denied(`${deniedPrefix}/*`) };
  }

  const { version, route } = splitVersion(path);
  if (upper === "POST" && route === "/containers/create") {
    return atLeastFloor(version, {
      kind: "container_create",
      versionPrefix: version === null ? "" : `/v${version}`,
    });
  }
  if (upper === "POST" && EXEC_CREATE_RE.test(route)) {
    return atLeastFloor(version, { kind: "exec_create" });
  }

  // Hijacked: `/exec/{id}/start` upgrades to raw bytes once Docker accepts.
  if (upper === "POST" && EXEC_START_RE.test(path)) {
    return { kind: "hijack" };
  }

  // `/containers/{id}/attach` — same hijack mechanism as exec/start.
  if (upper === "POST" && /\/(?:v[\d.]+\/)?containers\/[^/]+\/attach$/.test(path)) {
    return { kind: "hijack" };
  }

  // GET /containers/{id}/logs?follow=1 — long-polled stream. Without follow,
  // it's a normal short response; classify them both as hijack so the same
  // pipe handler covers both (it works equally well for short responses).
  if (upper === "GET" && /\/(?:v[\d.]+\/)?containers\/[^/]+\/logs$/.test(path)) {
    return { kind: "hijack" };
  }

  if (upper === "GET" && STREAMING_GET_RE.test(path)) {
    return { kind: "hijack" };
  }

  // Pass-through everything else: `/_ping`, `/version`, `/info`,
  // `/containers/json`, `/containers/{id}/json`, `/images/*`,
  // `/networks/*` (with policy on `POST /networks/create` etc.
  // layered in later sub-PRs), `/volumes/*`, `/system/df`, …
  // The other /containers/{id}/<action> calls flow through too — slice
  // 3 doesn't authz them yet (the per-task socket itself is the
  // boundary; the docker-id ownership map lands in a follow-up).
  return { kind: "forward" };
}

function atLeastFloor(version: string | null, outcome: RouteOutcome): RouteOutcome {
  if (version === null || compareVersions(version, MIN_API_VERSION) >= 0) return outcome;
  return {
    kind: "reject",
    rejection: denied(`API version v${version} (the minimum is v${MIN_API_VERSION})`),
  };
}

function splitVersion(path: string): { version: string | null; route: string } {
  const m = /^\/v([\d.]+)(\/.*)?$/.exec(path);
  return m?.[1] === undefined
    ? { version: null, route: path }
    : { version: m[1], route: m[2] ?? "/" };
}

/**
 * The daemon's `versions.compare`: dot-separated parts compared as
 * integers, a missing or unreadable part counting as 0.
 */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(versionPart);
  const right = b.split(".").map(versionPart);
  const length = Math.max(left.length, right.length);
  const diff = Array.from({ length }, (_, i) => (left[i] ?? 0) - (right[i] ?? 0)).find(
    (d) => d !== 0,
  );
  return Math.sign(diff ?? 0);
}

function versionPart(part: string): number {
  const n = Number(part);
  return /^\d+$/.test(part) && Number.isSafeInteger(n) ? n : 0;
}

function stripQuery(rawPath: string): string {
  const q = rawPath.indexOf("?");
  return q === -1 ? rawPath : rawPath.slice(0, q);
}

/**
 * Canonicalise a path before classification:
 *   1. percent-decode (handles `%2F`, `%5C`, `%2E` etc. — Docker decodes
 *      these on its end, so encoded variants of `/swarm` or `/etc` would
 *      otherwise route differently here than they execute on the daemon)
 *   2. collapse `\` to `/` (Windows-style path separators)
 *   3. collapse `//+` runs to `/`
 *   4. resolve `.` / `..` segments against the path root, stopping at `/`
 *
 * Malformed encoding (`%XX` with non-hex) is treated as opaque — keep the
 * raw bytes; the classifier still falls through to `forward` and the
 * daemon will reject. We don't try to be lenient here.
 */
function canonicalisePath(p: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    decoded = p;
  }
  // Backslash → slash; multiple slashes → one.
  let normalised = decoded.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!normalised.startsWith("/")) normalised = `/${normalised}`;

  // Resolve `.` / `..` segments. Bounded — segment count == slash count + 1.
  const segments = normalised.split("/");
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${out.join("/")}`;
}

/** True if `path` equals or starts with `prefix` (segment-aware). */
function matchesPrefix(path: string, prefix: string): boolean {
  // Strip optional API version prefix.
  const stripped = path.replace(/^\/v[\d.]+/, "");
  return stripped === prefix || stripped.startsWith(`${prefix}/`);
}
