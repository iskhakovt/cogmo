/**
 * Policy module for `POST /containers/create`. Pure — given a raw JSON body
 * and a task scope, returns either a `deny` (with reason and status code) or
 * a mutated body that the proxy forwards to the daemon.
 *
 * Defaults applied:
 *
 * - **Deny** `HostConfig.Privileged = true`. Privileged containers escape
 *   sysbox's userns isolation entirely; this is the proxy layer's job to
 *   block, not the userland gate's.
 * - **Deny** `HostConfig.NetworkMode = "host"` — the container would share
 *   the host's network namespace, defeating port isolation.
 * - **Deny** any `HostConfig.Binds` entry that mounts a host path. Named
 *   volumes (`volumeName:/inside/path`) pass through; arbitrary host paths
 *   (`/etc:/host-etc`) are rejected. The task container's own worktree
 *   mount is set up by the supervisor before the proxy sees any request,
 *   so children can't introduce new host-path mounts.
 * - **Deny** `HostConfig.CapAdd` containing any of `SYS_ADMIN`, `NET_ADMIN`,
 *   `SYS_PTRACE`, `SYS_MODULE`, `SYS_BOOT`, `SYS_RAWIO`, `MAC_ADMIN`,
 *   `MAC_OVERRIDE`. These would let the child container act on the host
 *   regardless of sysbox.
 *
 * Mutations applied:
 *
 * - Inject `HostConfig.Runtime` from the task's scope (`sysbox-runc` by
 *   default). A child explicitly setting `runtime: "runc"` is overridden.
 * - Inject `HostConfig.CgroupParent` from the task's scope, so every
 *   sibling lands under the task's slice and the kernel enforces the
 *   total-budget ceiling.
 * - Inject Cogmo labels (`cogmo.managed`, `cogmo.instance`, `cogmo.root_task`,
 *   `cogmo.parent`, `cogmo.depth`). Existing labels with the same keys are
 *   overwritten — child can't impersonate.
 */

import type { TaskScope } from "./types.js";

const DENIED_CAPS: ReadonlySet<string> = new Set([
  "SYS_ADMIN",
  "NET_ADMIN",
  "SYS_PTRACE",
  "SYS_MODULE",
  "SYS_BOOT",
  "SYS_RAWIO",
  "MAC_ADMIN",
  "MAC_OVERRIDE",
]);

export type ContainerCreatePolicyResult =
  | { kind: "deny"; status: number; message: string }
  | { kind: "allow"; body: Buffer };

interface ContainerCreateBody {
  Labels?: Record<string, string> | null;
  HostConfig?: {
    Privileged?: boolean;
    NetworkMode?: string;
    Binds?: string[] | null;
    CapAdd?: string[] | null;
    Runtime?: string;
    CgroupParent?: string;
  } | null;
}

/**
 * Run policy on a `POST /containers/create` body. Returns either a deny with
 * a 4xx status + JSON message body the proxy will surface to the caller, or
 * an allow with the mutated body to forward to the daemon.
 *
 * Caller is responsible for buffering the request body before invoking.
 */
export function applyContainerCreatePolicy(
  raw: Buffer,
  scope: TaskScope,
): ContainerCreatePolicyResult {
  let parsed: ContainerCreateBody;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as ContainerCreateBody;
  } catch (err) {
    return {
      kind: "deny",
      status: 400,
      message: `invalid JSON in request body: ${(err as Error).message}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "deny", status: 400, message: "request body must be a JSON object" };
  }

  const host = parsed.HostConfig ?? {};
  if (host.Privileged === true) {
    return {
      kind: "deny",
      status: 403,
      message: "HostConfig.Privileged is not allowed by the Cogmo proxy",
    };
  }
  if (host.NetworkMode === "host") {
    return {
      kind: "deny",
      status: 403,
      message: 'HostConfig.NetworkMode = "host" is not allowed by the Cogmo proxy',
    };
  }
  if (Array.isArray(host.Binds)) {
    for (const bind of host.Binds) {
      if (typeof bind !== "string") continue;
      const violation = inspectBind(bind);
      if (violation) {
        return { kind: "deny", status: 403, message: violation };
      }
    }
  }
  if (Array.isArray(host.CapAdd)) {
    for (const cap of host.CapAdd) {
      if (typeof cap !== "string") continue;
      const normalized = cap.replace(/^CAP_/, "").toUpperCase();
      if (DENIED_CAPS.has(normalized)) {
        return {
          kind: "deny",
          status: 403,
          message: `HostConfig.CapAdd contains denied capability ${cap}`,
        };
      }
    }
  }

  // Mutations — write a copy to avoid surprising callers that hold the
  // original buffer.
  const mutated: ContainerCreateBody = { ...parsed, HostConfig: { ...host } };
  // biome-ignore lint/style/noNonNullAssertion: we just spread it
  const mutatedHost = mutated.HostConfig!;
  mutatedHost.Runtime = scope.runtime;
  mutatedHost.CgroupParent = scope.cgroupParent;

  mutated.Labels = {
    ...(parsed.Labels ?? {}),
    "cogmo.managed": "true",
    "cogmo.instance": scope.instanceId,
    "cogmo.root_task": scope.taskId,
    "cogmo.parent": scope.parentDockerId,
    "cogmo.depth": String(scope.parentDepth + 1),
  };

  const out = Buffer.from(JSON.stringify(mutated), "utf8");
  return { kind: "allow", body: out };
}

/**
 * Inspect a single `Binds` entry for host-path mounts. Docker's bind syntax
 * is `<source>:<target>[:<options>]`. If `<source>` starts with `/` (or
 * looks like a Windows path, but we don't run on Windows), it's a host path
 * and gets denied. A name without `/` is a named volume — pass through.
 */
function inspectBind(bind: string): string | null {
  // Strip options suffix (`:ro`, `:rw,Z`, etc.) by splitting on `:` from the
  // right; the source is everything up to the first `:`.
  const firstColon = bind.indexOf(":");
  const source = firstColon === -1 ? bind : bind.slice(0, firstColon);
  if (source.length === 0) {
    return `HostConfig.Binds entry "${bind}" has empty source`;
  }
  if (source.startsWith("/")) {
    return `HostConfig.Binds host-path mount "${source}" is not allowed by the Cogmo proxy (use a named volume)`;
  }
  return null;
}
