/**
 * The outcomes of a proxied request other than a forward. Policy code
 * returns them as values; the HTTP edge maps each kind to its status here,
 * once (design/sandbox.md → Proxy Design → Authorization boundary).
 */

import { match, P } from "ts-pattern";

export type ProxyRejection =
  /**
   * A ref the daemon cannot resolve or the task does not own, or an image
   * the daemon does not have, in the daemon's own wording.
   */
  | { kind: "not_found"; message: string }
  /** A route, version, query key, body field or value the policy refuses. */
  | { kind: "denied"; message: string }
  /** A body that is not a JSON object, fails its schema or breaks a key rule. */
  | { kind: "malformed"; message: string }
  /** A body to be rewritten that is over the size cap. */
  | { kind: "too_large"; maxBytes: number }
  /** A store read or daemon lookup the checks need failed; the client may retry. */
  | { kind: "unavailable"; message: string }
  /** The daemon connection for the forward itself failed. */
  | { kind: "daemon_failed"; message: string };

export function rejectionStatus(rejection: ProxyRejection): number {
  return match(rejection)
    .with({ kind: "not_found" }, () => 404)
    .with({ kind: "denied" }, () => 403)
    .with({ kind: "malformed" }, () => 400)
    .with({ kind: "too_large" }, () => 413)
    .with({ kind: "unavailable" }, () => 503)
    .with({ kind: "daemon_failed" }, () => 502)
    .exhaustive();
}

export function rejectionMessage(rejection: ProxyRejection): string {
  return match(rejection)
    .with(
      { kind: "too_large" },
      ({ maxBytes }) => `Cogmo proxy: request body exceeds ${maxBytes} bytes`,
    )
    .with(
      { kind: P.union("not_found", "denied", "malformed", "unavailable", "daemon_failed") },
      ({ message }) => message,
    )
    .exhaustive();
}

/** A `denied` naming what was refused. */
export function denied(what: string): ProxyRejection {
  return { kind: "denied", message: `${what} is not allowed by the Cogmo proxy` };
}

export function notFound(message: string): Extract<ProxyRejection, { kind: "not_found" }> {
  return { kind: "not_found", message };
}

export function malformed(message: string): Extract<ProxyRejection, { kind: "malformed" }> {
  return { kind: "malformed", message: `Cogmo proxy: ${message}` };
}

export function unavailable(message: string): Extract<ProxyRejection, { kind: "unavailable" }> {
  return { kind: "unavailable", message: `Cogmo proxy: ${message}` };
}

export function daemonFailed(message: string): Extract<ProxyRejection, { kind: "daemon_failed" }> {
  return { kind: "daemon_failed", message };
}
