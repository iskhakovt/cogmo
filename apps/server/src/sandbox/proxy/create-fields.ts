/**
 * Value rules for the allowlisted fields of a container create that are not
 * resources (design/sandbox.md → Proxy Design → Create policy). Each check
 * names the first value it refuses.
 *
 * A task owns no networks or volumes, so every named-volume mount is
 * denied and only `default`, `bridge` and `none` networks are accepted
 * (design/sandbox.md → Slices, item 5 adds owned ones).
 */

import { err, ok, Result } from "neverthrow";
import { match } from "ts-pattern";
import type { CreateBody, CreateHostConfig, CreatePortBindings } from "./body-schemas.js";
import { denied, type ProxyRejection } from "./rejection.js";
import { checkSysboxEnv } from "./sysbox-env.js";
import type { TaskScope } from "./types.js";

/** Docker's default capability set (moby `oci/caps.DefaultCapabilities`). */
const DOCKER_DEFAULT_CAPS = [
  "AUDIT_WRITE",
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "FSETID",
  "KILL",
  "MKNOD",
  "NET_BIND_SERVICE",
  "NET_RAW",
  "SETFCAP",
  "SETGID",
  "SETPCAP",
  "SETUID",
  "SYS_CHROOT",
] as const;

const CAPS_UNDER_RUNC: ReadonlySet<string> = new Set([...DOCKER_DEFAULT_CAPS, "IPC_LOCK"]);
/**
 * `SYS_NICE` only under sysbox-runc, where it is namespaced. Under runc it is
 * the real capability, and `SCHED_FIFO` escapes the CFS quota.
 */
const CAPS_UNDER_SYSBOX: ReadonlySet<string> = new Set([...CAPS_UNDER_RUNC, "SYS_NICE"]);

const SECURITY_OPTS: ReadonlySet<string> = new Set([
  "no-new-privileges",
  "no-new-privileges:true",
  "no-new-privileges=true",
]);
const RESTART_POLICIES: ReadonlySet<string> = new Set(["", "no", "on-failure"]);
const IPC_MODES: ReadonlySet<string> = new Set(["", "private", "none", "shareable"]);
const CGROUPNS_MODES: ReadonlySet<string> = new Set(["", "private"]);
const NETWORK_MODES: ReadonlySet<string> = new Set(["", "default", "bridge", "none"]);
const ENDPOINT_NETWORKS: ReadonlySet<string> = new Set(["default", "bridge", "none"]);
const ULIMITS: ReadonlySet<string> = new Set(["nofile", "nproc"]);
const MOUNT_TYPES: ReadonlySet<string> = new Set(["tmpfs"]);
const HOST_PORTS: ReadonlySet<string> = new Set(["", "0"]);

const COGMO_LABEL_PREFIX = "cogmo.";

/** Every rule on the create's config and `HostConfig` fields other than resources. */
export function checkCreateFields(
  body: CreateBody,
  scope: Pick<TaskScope, "runtime">,
): Result<void, ProxyRejection> {
  const host = body.HostConfig ?? {};
  return Result.combine([
    checkSysboxEnv(body.Env, "Env"),
    checkCapAdd(host.CapAdd, scope.runtime),
    memberOf("HostConfig.SecurityOpt", host.SecurityOpt ?? [], SECURITY_OPTS),
    memberOf("HostConfig.RestartPolicy.Name", [host.RestartPolicy?.Name], RESTART_POLICIES),
    memberOf("HostConfig.IpcMode", [host.IpcMode], IPC_MODES),
    memberOf("HostConfig.CgroupnsMode", [host.CgroupnsMode], CGROUPNS_MODES),
    memberOf("HostConfig.NetworkMode", [host.NetworkMode], NETWORK_MODES),
    memberOf(
      "NetworkingConfig.EndpointsConfig network",
      Object.keys(body.NetworkingConfig?.EndpointsConfig ?? {}),
      ENDPOINT_NETWORKS,
    ),
    memberOf(
      "HostConfig.Ulimits Name",
      (host.Ulimits ?? []).map((u) => u.Name),
      ULIMITS,
    ),
    memberOf(
      "HostConfig.Mounts Type",
      (host.Mounts ?? []).map((m) => m.Type),
      MOUNT_TYPES,
    ),
    checkBinds(host.Binds),
    memberOf(
      "HostConfig.PortBindings HostPort",
      portBindingList(host.PortBindings).map((b) => b.HostPort),
      HOST_PORTS,
    ),
    (host.OomScoreAdj ?? 0) < 0
      ? err(denied(`HostConfig.OomScoreAdj ${host.OomScoreAdj}`))
      : ok(undefined),
  ]).map(() => undefined);
}

/** The caller's labels without any `cogmo.` key, plus the Cogmo labels from the scope. */
export function taskLabels(
  labels: Readonly<Record<string, string>> | null | undefined,
  scope: Pick<TaskScope, "instanceId" | "taskId" | "parentDockerId" | "parentDepth">,
): Record<string, string> {
  const own = Object.entries(labels ?? {}).filter(
    ([key]) => !key.toLowerCase().startsWith(COGMO_LABEL_PREFIX),
  );
  return {
    ...Object.fromEntries(own),
    "cogmo.managed": "true",
    "cogmo.instance": scope.instanceId,
    "cogmo.root_task": scope.taskId,
    "cogmo.parent": scope.parentDockerId,
    "cogmo.depth": String(scope.parentDepth + 1),
  };
}

export function publishesPorts(bindings: CreateHostConfig["PortBindings"]): boolean {
  return portBindingList(bindings).length > 0;
}

/**
 * Every published port bound on `address` (`DaemonLookups.publishAddress`),
 * so it is not bound on the host's other interfaces.
 */
export function bindPublishedPorts(
  bindings: CreatePortBindings,
  address: string,
): CreatePortBindings {
  return Object.fromEntries(
    Object.entries(bindings).map(([port, list]) => [
      port,
      list?.map((binding) => ({ ...binding, HostIp: address })) ?? list,
    ]),
  );
}

/**
 * Names are compared upper-cased with a leading `CAP_` stripped, as the
 * daemon normalizes them. `ALL` is not in either set.
 */
function checkCapAdd(
  caps: ReadonlyArray<string> | null | undefined,
  runtime: TaskScope["runtime"],
): Result<void, ProxyRejection> {
  const allowed = match(runtime)
    .with("sysbox-runc", () => CAPS_UNDER_SYSBOX)
    .with("runc", () => CAPS_UNDER_RUNC)
    .exhaustive();
  const refused = (caps ?? []).find((cap) => !allowed.has(cap.toUpperCase().replace(/^CAP_/, "")));
  return refused === undefined
    ? ok(undefined)
    : err(denied(`HostConfig.CapAdd ${JSON.stringify(refused)} under ${runtime}`));
}

/** A `Binds` entry mounts a host path or a named volume, and a task owns neither. */
function checkBinds(binds: ReadonlyArray<string> | null | undefined): Result<void, ProxyRejection> {
  const bind = (binds ?? [])[0];
  return bind === undefined
    ? ok(undefined)
    : err(denied(`HostConfig.Binds entry ${JSON.stringify(bind)}`));
}

function memberOf(
  field: string,
  values: ReadonlyArray<string | null | undefined>,
  allowed: ReadonlySet<string>,
): Result<void, ProxyRejection> {
  const refused = values.map((value) => value ?? "").find((value) => !allowed.has(value));
  return refused === undefined ? ok(undefined) : err(denied(`${field} ${JSON.stringify(refused)}`));
}

function portBindingList(bindings: CreateHostConfig["PortBindings"]) {
  return Object.values(bindings ?? {}).flatMap((list) => list ?? []);
}
