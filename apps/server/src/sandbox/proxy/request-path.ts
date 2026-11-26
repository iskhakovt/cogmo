/**
 * The request target as the daemon routes it, and the canonical path the
 * proxy forwards in its place (design/sandbox.md → Proxy Design → The
 * forwarded request).
 *
 * The daemon's router (gorilla/mux) matches the percent-decoded path,
 * answers an unclean one (`//`, `.`, `..`) with a redirect to its clean
 * form, and takes an optional `/v{version:[0-9.]+}` prefix. The proxy
 * classifies the decoded, cleaned path and forwards a path it builds from
 * that, so what the daemon routes is what the proxy checked.
 */

import { err, ok, type Result } from "neverthrow";
import * as R from "remeda";
import { denied, malformed, type ProxyRejection } from "./rejection.js";

/**
 * Every route reads its body and query with API 1.44 semantics, so an older
 * version prefix is denied. A request with no prefix gets the daemon's own
 * version, which Cogmo requires to be 1.44 or later.
 */
const MIN_API_VERSION = "1.44";

export interface RequestTarget {
  /** `""`, or the request's `/v<version>` as sent; forwarded as is. */
  versionPrefix: string;
  /** The decoded path without the version prefix, dot-segments resolved and empty segments dropped. */
  route: string;
  query: URLSearchParams;
}

/**
 * Split a request target into its version prefix, canonical route and
 * query. A target outside printable ASCII or with a fragment is
 * `malformed`, and so is a percent escape in the path that does not decode
 * to UTF-8 or one in the query that is not two hex digits, which
 * `URLSearchParams` would otherwise keep as literal text. A version prefix
 * below `MIN_API_VERSION` is `denied`.
 */
export function parseTarget(raw: string): Result<RequestTarget, ProxyRejection> {
  if (!/^[\x21-\x7e]*$/.test(raw) || raw.includes("#")) {
    return err(malformed("the request target is not a printable ASCII path and query"));
  }
  const at = raw.indexOf("?");
  const rawPath = at === -1 ? raw : raw.slice(0, at);
  const rawQuery = at === -1 ? "" : raw.slice(at + 1);
  if (/%(?![0-9A-Fa-f]{2})/.test(rawQuery)) {
    return err(malformed("the request query has a malformed percent-encoding"));
  }
  const query = new URLSearchParams(rawQuery);
  return decodePath(rawPath).andThen((decoded) => {
    const path = canonicalisePath(decoded);
    const m = /^\/v([\d.]+)(\/.*)?$/.exec(path);
    const version = m?.[1];
    if (version === undefined) return ok({ versionPrefix: "", route: path, query });
    if (compareVersions(version, MIN_API_VERSION) < 0) {
      return err(denied(`API version v${version} (the minimum is v${MIN_API_VERSION})`));
    }
    return ok({ versionPrefix: `/v${version}`, route: m?.[2] ?? "/", query });
  });
}

/** `path` with `query` appended, when it has any key. */
export function withQuery(path: string, query: URLSearchParams): string {
  const serialised = query.toString();
  return serialised === "" ? path : `${path}?${serialised}`;
}

/**
 * A decoded path or ref, percent-encoded segment by segment so the daemon
 * decodes it back to the same segments: `/` stays a separator, and `:` and
 * `@`, legal in a path segment, stay as they are (`/images/alpine:3/json`).
 */
export function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/%3A/g, ":").replace(/%40/g, "@"))
    .join("/");
}

function decodePath(rawPath: string): Result<string, ProxyRejection> {
  try {
    return ok(decodeURIComponent(rawPath));
  } catch {
    return err(malformed("the request path has a malformed percent-encoding"));
  }
}

/**
 * Collapse `\` to `/`, drop empty and `.` segments, and resolve `..`
 * against the root, so `/v1.43/swarm%2Finit`, `/swarm/./x` and
 * `//containers//x/json` classify as the daemon routes them.
 */
function canonicalisePath(decoded: string): string {
  const resolved = R.reduce(
    decoded.replace(/\\/g, "/").split("/"),
    (kept: string[], segment) => {
      if (segment === "..") kept.pop();
      else if (segment !== "" && segment !== ".") kept.push(segment);
      return kept;
    },
    [],
  );
  return `/${resolved.join("/")}`;
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
