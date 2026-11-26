/**
 * The allowlist for `POST /containers/create` and `POST /containers/{id}/exec`
 * bodies, as Zod schemas (design/sandbox.md → Proxy Design → Create policy,
 * Exec policy). A field listed here is read and kept; `key-rules.ts` drops
 * or denies any other. Value rules beyond the shape live in
 * `create-fields.ts`, `resources.ts` and `sysbox-env.ts`.
 *
 * Every field is nullable, as Go's decoder reads `null` as "not set", and
 * every number an integer in the safe range, as the daemon's are `int64`.
 */

import { z } from "zod";

function optional<T extends z.ZodType>(schema: T) {
  return schema.nullable().optional();
}

const Str = optional(z.string());
const Bool = optional(z.boolean());
const Int = optional(z.number().int());
const Strings = optional(z.array(z.string()));
/** A Go `struct{}`: the value of an `ExposedPorts` or `Volumes` entry. */
const EmptyStruct = z.strictObject({}).nullable();
/** Read, then dropped or overwritten from the scope, whatever it holds. */
const Replaced = z.unknown().optional();
const ConsoleSize = optional(
  z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
);

/**
 * A reference the proxy can put in a lookup path: a name, tag, digest or id
 * from the reference grammar's characters, with no empty, `.` or `..`
 * segment. The daemon rejects anything else it cannot parse.
 */
const ImageRef = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/, "not an image reference")
  .refine(
    (ref) => ref.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."),
    "not an image reference",
  );

const Healthcheck = z.strictObject({
  Test: Strings,
  Interval: Int,
  Timeout: Int,
  StartPeriod: Int,
  StartInterval: Int,
  Retries: Int,
});

const Ulimit = z.strictObject({ Name: z.string(), Soft: Int, Hard: Int });

const RestartPolicy = z.strictObject({ Name: Str, MaximumRetryCount: Int });

const PortBinding = z.strictObject({ HostIp: Str, HostPort: Str });

const TmpfsOptions = z.strictObject({
  SizeBytes: Int,
  Mode: Int,
  Options: optional(z.array(z.array(z.string()))),
});

const Mount = z.strictObject({
  Type: z.string(),
  Target: Str,
  ReadOnly: Bool,
  Consistency: Str,
  TmpfsOptions: optional(TmpfsOptions),
});

const EndpointSettings = z.strictObject({ Aliases: Strings });

const HostConfig = z.strictObject({
  Memory: Int,
  MemorySwap: Int,
  MemoryReservation: Int,
  MemorySwappiness: Int,
  PidsLimit: Int,
  NanoCpus: Int,
  CpuQuota: Int,
  CpuPeriod: Int,
  CpuShares: Int,
  CpusetCpus: Str,
  CpusetMems: Str,
  ShmSize: Int,
  OomScoreAdj: Int,
  Ulimits: optional(z.array(Ulimit)),
  CapAdd: Strings,
  CapDrop: Strings,
  GroupAdd: Strings,
  Init: Bool,
  ReadonlyRootfs: Bool,
  AutoRemove: Bool,
  ExtraHosts: Strings,
  Dns: Strings,
  DnsOptions: Strings,
  DnsSearch: Strings,
  ConsoleSize,
  SecurityOpt: Strings,
  RestartPolicy: optional(RestartPolicy),
  IpcMode: Str,
  CgroupnsMode: Str,
  NetworkMode: Str,
  PortBindings: optional(z.record(z.string(), optional(z.array(PortBinding)))),
  Tmpfs: optional(z.record(z.string(), z.string())),
  Mounts: optional(z.array(Mount)),
  Binds: Strings,
  Runtime: Replaced,
  CgroupParent: Replaced,
});

export type CreateHostConfig = z.output<typeof HostConfig>;
export type CreatePortBindings = NonNullable<CreateHostConfig["PortBindings"]>;

const NetworkingConfig = z.strictObject({
  EndpointsConfig: optional(z.record(z.string(), optional(EndpointSettings))),
});

export const CreateBodySchema = z.strictObject({
  Image: ImageRef,
  name: Replaced,
  platform: Replaced,
  Cmd: Strings,
  Entrypoint: Strings,
  WorkingDir: Str,
  User: Str,
  Hostname: Str,
  Domainname: Str,
  Env: Strings,
  Labels: optional(z.record(z.string(), z.string())),
  ExposedPorts: optional(z.record(z.string(), EmptyStruct)),
  Volumes: optional(z.record(z.string(), EmptyStruct)),
  Healthcheck: optional(Healthcheck),
  StopSignal: Str,
  StopTimeout: Int,
  Shell: Strings,
  Tty: Bool,
  OpenStdin: Bool,
  StdinOnce: Bool,
  AttachStdin: Bool,
  AttachStdout: Bool,
  AttachStderr: Bool,
  NetworkDisabled: Bool,
  HostConfig: optional(HostConfig),
  NetworkingConfig: optional(NetworkingConfig),
});

export type CreateBody = z.output<typeof CreateBodySchema>;

export const ExecBodySchema = z.strictObject({
  Cmd: z.array(z.string()).min(1),
  Env: Strings,
  WorkingDir: Str,
  User: Str,
  Tty: Bool,
  AttachStdin: Bool,
  AttachStdout: Bool,
  AttachStderr: Bool,
  DetachKeys: Str,
  ConsoleSize,
  /** Read only from the start body; CLIs before 29 also send it on the create. */
  Detach: Bool,
});
