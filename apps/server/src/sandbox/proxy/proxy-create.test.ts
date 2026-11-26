import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { okAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import { expectDefined } from "../../test/assertions.js";
import { DOCKER_CLI_CREATE_REQUEST } from "../../test/docker-cli-create-request.js";
import {
  BRIDGE_NETWORK,
  dockerApi,
  type FakeDaemonRequest,
  type FakeDaemonResponder,
  type FakeDockerDaemon,
  type FakeImage,
  requestOverSocket,
  respondJson,
  type SocketResponse,
  startFakeDockerDaemon,
} from "../../test/fake-docker-daemon.js";
import { TESTCONTAINERS_CREATE_REQUEST } from "../../test/testcontainers-create-request.js";
import { CogmoSocketProxy } from "./index.js";
import type { ChildContainers, ContainerRows, TaskScope } from "./types.js";

const GIB = 1024 ** 3;
const ALPINE_ID = `sha256:${"a".repeat(64)}`;
const POSTGRES_ID = `sha256:${"b".repeat(64)}`;
const SYSBOX_IMAGE_ID = `sha256:${"c".repeat(64)}`;
const POSTGRES_ALPINE_ID = `sha256:${"d".repeat(64)}`;
const GATEWAY = "172.17.0.1";

const IMAGES: ReadonlyMap<string, FakeImage> = new Map([
  ["alpine", { id: ALPINE_ID, env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/bin"] }],
  ["mirror.gcr.io/pgvector/pgvector:pg18", { id: POSTGRES_ID, env: ["PGDATA=/var/lib/pg"] }],
  ["sysbox-tuned", { id: SYSBOX_IMAGE_ID, env: ["Sysbox_Honor_Caps=TRUE"] }],
  ["postgres:18-alpine", { id: POSTGRES_ALPINE_ID, env: ["PGDATA=/var/lib/pg"] }],
]);

/** The task's depth-0 container. */
const ANCHOR = { rowId: "019d0000-0000-7000-8000-00000000bbbb", dockerId: "docker-parent-abc" };

const SCOPE: TaskScope = {
  taskId: "019d0000-0000-7000-8000-00000000aaaa",
  anchor: ANCHOR,
  parentDepth: 0,
  runtime: "sysbox-runc",
  cgroupParent: "cogmo-task-abc.slice",
  instanceId: "019d0000-0000-7000-8000-0000000000ff",
  resourceLimits: { cpus: 2, memory_bytes: GIB, pids: 256 },
  ttlExpiresAt: new Date("2026-12-01T00:00:00.000Z"),
};

const ForwardedSchema = z.looseObject({
  Image: z.string(),
  Labels: z.record(z.string(), z.string()),
  HostConfig: z.record(z.string(), z.unknown()),
});

const ErrorSchema = z.object({ message: z.string() });

/** The fake daemon with these images, no containers and only `bridge`. */
function createApi(daemon: { arch: string; rootless: boolean }): FakeDaemonResponder {
  return dockerApi({
    images: IMAGES,
    containers: [],
    networks: [BRIDGE_NETWORK],
    bridgeGateway: GATEWAY,
    ...daemon,
  });
}

const AMD64_API = createApi({ arch: "amd64", rootless: false });

let baseDir: string;
let daemon: FakeDockerDaemon;
let proxy: CogmoSocketProxy;
let socket: string;

async function startDaemon(arch: string): Promise<void> {
  daemon = await startFakeDockerDaemon(
    join(baseDir, "docker.sock"),
    createApi({ arch, rootless: false }),
  );
}

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "cogmo-proxy-create-"));
  await startDaemon("amd64");
  // The task's own row, which a create's child is recorded under, and no children.
  const containerRows = mock<ContainerRows>();
  containerRows.forTask.mockReturnValue(
    okAsync([
      {
        id: ANCHOR.rowId,
        dockerId: ANCHOR.dockerId,
        parentId: null,
        status: "running",
      },
    ]),
  );
  const childContainers = mock<ChildContainers>();
  childContainers.record.mockReturnValue(okAsync(undefined));
  proxy = await CogmoSocketProxy.create({
    socketDir: join(baseDir, "sockets"),
    hostDockerSocket: daemon.socketPath,
    containerRows,
    childContainers,
  });
  socket = await proxy.registerTask(SCOPE);
});

afterEach(async () => {
  await proxy.close();
  await daemon.close();
  await rm(baseDir, { recursive: true, force: true });
});

function create(body: unknown, query: string): Promise<SocketResponse> {
  return createRaw(JSON.stringify(body), `/containers/create${query}`);
}

function createRaw(body: string, path: string): Promise<SocketResponse> {
  return requestOverSocket(socket, { method: "POST", path, body });
}

function creates(): FakeDaemonRequest[] {
  return daemon.requests().filter((r) => /\/containers\/create(\?|$)/.test(r.url));
}

function forwarded(): z.infer<typeof ForwardedSchema> {
  const [only, ...rest] = creates();
  expect(rest).toEqual([]);
  return ForwardedSchema.parse(JSON.parse(expectDefined(only, "forwarded create").body));
}

function message(r: SocketResponse): string {
  return ErrorSchema.parse(JSON.parse(r.body)).message;
}

async function expectRejected(r: SocketResponse, status: number): Promise<void> {
  expect(r.status, r.body).toBe(status);
  expect(daemon.requests()).toEqual([]);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read a nested value; `undefined` where any step is missing. */
function dig(value: unknown, path: ReadonlyArray<string | number>): unknown {
  return path.reduce<unknown>((cur, seg) => {
    if (typeof seg === "number") return Array.isArray(cur) ? cur.at(seg) : undefined;
    return isRecord(cur) ? cur[seg] : undefined;
  }, value);
}

/** `{ a: { b: value } }` for `nest("a", ["b"], value)`. */
function nest(head: string, rest: ReadonlyArray<string>, value: unknown): Record<string, unknown> {
  const [next, ...more] = rest;
  return { [head]: next === undefined ? value : nest(next, more, value) };
}

/**
 * Fields the create policy does not allow. Each is `denied` when non-zero
 * and dropped when zero.
 */
const DENIED_FIELDS: ReadonlyArray<[string, ReadonlyArray<string>, unknown, unknown]> = [
  ["ArgsEscaped", [], true, false],
  ["OnBuild", [], ["RUN id"], null],
  ["MacAddress", [], "02:42:ac:11:00:02", ""],
  ["FutureField", [], { Enabled: true }, { Enabled: false }],
  ["HostConfig", ["Privileged"], true, false],
  ["HostConfig", ["VolumesFrom"], ["sibling"], null],
  ["HostConfig", ["VolumeDriver"], "local", ""],
  [
    "HostConfig",
    ["Devices"],
    [{ PathOnHost: "/dev/kmsg", PathInContainer: "/dev/kmsg", CgroupPermissions: "rwm" }],
    null,
  ],
  ["HostConfig", ["DeviceRequests"], [{ Driver: "nvidia", Count: -1 }], null],
  ["HostConfig", ["DeviceCgroupRules"], ["c 1:3 mr"], null],
  ["HostConfig", ["PidMode"], "host", ""],
  ["HostConfig", ["UTSMode"], "host", ""],
  ["HostConfig", ["UsernsMode"], "host", ""],
  ["HostConfig", ["Cgroup"], "container:sibling", ""],
  ["HostConfig", ["Sysctls"], { "net.ipv4.ip_forward": "1" }, {}],
  ["HostConfig", ["MaskedPaths"], [], null],
  ["HostConfig", ["ReadonlyPaths"], [], null],
  ["HostConfig", ["Links"], ["db:db"], null],
  ["HostConfig", ["PublishAllPorts"], true, false],
  ["HostConfig", ["OomKillDisable"], true, null],
  ["HostConfig", ["LogConfig"], { Type: "syslog", Config: {} }, { Type: "", Config: null }],
  ["HostConfig", ["StorageOpt"], { size: "100G" }, null],
  ["HostConfig", ["Annotations"], { "io.example": "x" }, null],
  ["HostConfig", ["BlkioWeight"], 500, 0],
  ["HostConfig", ["BlkioWeightDevice"], [{ Path: "/dev/sda", Weight: 10 }], null],
  ["HostConfig", ["BlkioDeviceReadBps"], [{ Path: "/dev/sda", Rate: 1 }], null],
  ["HostConfig", ["BlkioDeviceWriteBps"], [{ Path: "/dev/sda", Rate: 1 }], null],
  ["HostConfig", ["BlkioDeviceReadIOps"], [{ Path: "/dev/sda", Rate: 1 }], null],
  ["HostConfig", ["BlkioDeviceWriteIOps"], [{ Path: "/dev/sda", Rate: 1 }], null],
  ["HostConfig", ["CpuRealtimePeriod"], 1_000_000, 0],
  ["HostConfig", ["CpuRealtimeRuntime"], 950_000, 0],
  ["HostConfig", ["KernelMemory"], 1_048_576, 0],
  ["HostConfig", ["KernelMemoryTCP"], 1_048_576, 0],
  ["HostConfig", ["ContainerIDFile"], "/tmp/id", ""],
  ["HostConfig", ["Isolation"], "hyperv", ""],
  ["HostConfig", ["CpuCount"], 1, 0],
  ["HostConfig", ["CpuPercent"], 50, 0],
  ["HostConfig", ["IOMaximumIOps"], 1, 0],
  ["HostConfig", ["IOMaximumBandwidth"], 1, 0],
  ["HostConfig", ["Umask"], 18, null],
  ["HostConfig", ["Capabilities"], ["CAP_SYS_ADMIN"], null],
  ["HostConfig", ["FutureOption"], true, false],
  ["HostConfig", ["RestartPolicy", "FutureKnob"], 3, 0],
  [
    "NetworkingConfig",
    ["EndpointsConfig", "bridge", "IPAMConfig"],
    { IPv4Address: "10.0.0.9" },
    null,
  ],
  ["NetworkingConfig", ["EndpointsConfig", "bridge", "Links"], ["db"], null],
  ["NetworkingConfig", ["EndpointsConfig", "bridge", "DriverOpts"], { k: "v" }, null],
  ["NetworkingConfig", ["EndpointsConfig", "bridge", "MacAddress"], "02:42:ac:11:00:02", ""],
  ["NetworkingConfig", ["EndpointsConfig", "bridge", "GwPriority"], 1, 0],
  ["NetworkingConfig", ["EndpointsConfig", "bridge", "NetworkID"], "abc", ""],
  ["NetworkingConfig", ["FutureSetting"], "x", ""],
];

describe("create policy: fields outside the allowlist", () => {
  it.each(DENIED_FIELDS)("%s.%s set non-zero is denied", async (head, rest, nonZero) => {
    const r = await create({ Image: "alpine", ...nest(head, rest, nonZero) }, "");

    await expectRejected(r, 403);
    expect(message(r)).toContain(rest.at(-1) ?? head);
  });

  it.each(DENIED_FIELDS)("%s.%s zero-valued is dropped", async (head, rest, _nonZero, zero) => {
    const r = await create({ Image: "alpine", ...nest(head, rest, zero) }, "");

    expect(r.status, r.body).toBe(201);
    expect(dig(forwarded(), [head, ...rest])).toBeUndefined();
  });

  it.each([
    "Devices",
    "DeviceRequests",
    "DeviceCgroupRules",
    "VolumesFrom",
    "Links",
    "BlkioWeightDevice",
    "BlkioDeviceReadBps",
    "BlkioDeviceWriteIOps",
  ])("HostConfig.%s as an empty list is dropped", async (field) => {
    const r = await create({ Image: "alpine", HostConfig: { [field]: [] } }, "");

    expect(r.status, r.body).toBe(201);
    expect(dig(forwarded(), ["HostConfig", field])).toBeUndefined();
  });

  it.each([
    ["Source", "scratch-vol", ""],
    ["BindOptions", { Propagation: "rshared" }, null],
    ["VolumeOptions", { NoCopy: true }, null],
  ])(
    "a tmpfs mount's %s is denied when set and dropped when zero",
    async (field, nonZero, zero) => {
      const mount = (v: unknown) => ({
        Image: "alpine",
        HostConfig: { Mounts: [{ Type: "tmpfs", Target: "/scratch", [field]: v }] },
      });

      const denied = await create(mount(nonZero), "");
      await expectRejected(denied, 403);
      expect(message(denied)).toContain(field);

      const passed = await create(mount(zero), "");
      expect(passed.status, passed.body).toBe(201);
      expect(dig(forwarded(), ["HostConfig", "Mounts", 0, field])).toBeUndefined();
    },
  );

  it.each([
    ["PidMode", "container:sibling"],
    ["NetworkMode", "container:sibling"],
    ["IpcMode", "container:sibling"],
    ["IpcMode", "host"],
    ["CgroupnsMode", "host"],
    ["NetworkMode", "host"],
  ])("HostConfig.%s = %s is denied", async (field, value) => {
    const r = await create({ Image: "alpine", HostConfig: { [field]: value } }, "");

    await expectRejected(r, 403);
    expect(message(r)).toContain(field);
  });
});

describe("create policy: key rules", () => {
  it.each([
    ["hostconfig", { image: "alpine", hostconfig: { privileged: true } }],
    ["HOSTCONFIG.privileged", { Image: "alpine", HOSTCONFIG: { privileged: true } }],
    ["HostConfig.PRIVILEGED", { Image: "alpine", HostConfig: { PRIVILEGED: true } }],
    ["hostConfig.pidmode", { Image: "alpine", hostConfig: { pidmode: "host" } }],
  ])("reads the case variant %s", async (_label, body) => {
    await expectRejected(await create(body, ""), 403);
  });

  it("forwards a case variant under its canonical name", async () => {
    const r = await create({ image: "alpine", hostconfig: { memory: 1024, autoremove: true } }, "");

    expect(r.status, r.body).toBe(201);
    const body = forwarded();
    expect(body.HostConfig.Memory).toBe(1024);
    expect(body.HostConfig.AutoRemove).toBe(true);
    expect(body).not.toHaveProperty("image");
    expect(body).not.toHaveProperty("hostconfig");
  });

  it.each([
    ["two keys that differ only in case", '{"Image":"alpine","image":"busybox"}'],
    [
      "nested keys that differ only in case",
      '{"Image":"alpine","HostConfig":{"Memory":1,"memory":2}}',
    ],
    ["a non-ASCII key", '{"Image":"alpine","HostConfig":{"Privileğed":true}}'],
    ["a key Go folds onto an ASCII field", '{"Image":"alpine","HostConfig":{"ſecurityOpt":["x"]}}'],
    ["a __proto__ key", '{"Image":"alpine","__proto__":{"Privileged":true}}'],
    ["a constructor key", '{"Image":"alpine","HostConfig":{"constructor":{}}}'],
    ["a prototype key", '{"Image":"alpine","prototype":1}'],
    ["a __proto__ label", '{"Image":"alpine","Labels":{"__proto__":"x"}}'],
    ["a string Memory", '{"Image":"alpine","HostConfig":{"Memory":"1e12"}}'],
    ["a fractional PidsLimit", '{"Image":"alpine","HostConfig":{"PidsLimit":1.5}}'],
    ["a Memory above 2^53", '{"Image":"alpine","HostConfig":{"Memory":9007199254740993}}'],
    ["a string Cmd", '{"Image":"alpine","Cmd":"sh"}'],
    ["no Image", '{"Cmd":["sh"]}'],
    ["an array body", "[]"],
    ["a null body", "null"],
    ["invalid JSON", "{"],
  ])("%s is malformed", async (_label, raw) => {
    await expectRejected(await createRaw(raw, "/containers/create"), 400);
  });

  it("keeps data-keyed map entries that differ only in case or are not ASCII", async () => {
    const labels = { Team: "a", team: "b", équipe: "c" };
    const r = await create({ Image: "alpine", Labels: labels }, "");

    expect(r.status, r.body).toBe(201);
    expect(forwarded().Labels).toMatchObject(labels);
  });
});

describe("create policy: labels and env", () => {
  it("replaces a caller's cogmo.* labels in any case", async () => {
    const r = await create(
      {
        Image: "alpine",
        Labels: {
          "user.foo": "bar",
          "COGMO.root_task": "other",
          "Cogmo.Parent": "spoof",
          "cogmo.x": "y",
        },
      },
      "",
    );

    expect(r.status, r.body).toBe(201);
    expect(forwarded().Labels).toEqual({
      "user.foo": "bar",
      "cogmo.managed": "true",
      "cogmo.instance": SCOPE.instanceId,
      "cogmo.root_task": SCOPE.taskId,
      "cogmo.parent": ANCHOR.dockerId,
      "cogmo.depth": "1",
    });
  });

  it.each(["SYSBOX_IGNORE_SYSFS=1", "sysbox_honor_caps=TRUE", "Sysbox_X"])(
    "denies the env entry %s",
    async (entry) => {
      const r = await create({ Image: "alpine", Env: ["A=1", entry] }, "");

      await expectRejected(r, 403);
      expect(message(r)).toContain("SYSBOX_");
    },
  );

  it("forwards an env without SYSBOX_ entries", async () => {
    const env = ["A=1", "MY_SYSBOX_NOTE=1", "B"];
    const r = await create({ Image: "alpine", Env: env }, "");

    expect(r.status, r.body).toBe(201);
    expect(forwarded().Env).toEqual(env);
  });
});

/** Every Linux capability outside Docker's defaults, `IPC_LOCK` and `SYS_NICE`. */
const DENIED_CAPS = [
  "DAC_READ_SEARCH",
  "LINUX_IMMUTABLE",
  "NET_BROADCAST",
  "NET_ADMIN",
  "IPC_OWNER",
  "SYS_MODULE",
  "SYS_RAWIO",
  "SYS_PTRACE",
  "SYS_PACCT",
  "SYS_ADMIN",
  "SYS_BOOT",
  "SYS_RESOURCE",
  "SYS_TIME",
  "SYS_TTY_CONFIG",
  "LEASE",
  "AUDIT_CONTROL",
  "MAC_OVERRIDE",
  "MAC_ADMIN",
  "SYSLOG",
  "WAKE_ALARM",
  "BLOCK_SUSPEND",
  "AUDIT_READ",
  "PERFMON",
  "BPF",
  "CHECKPOINT_RESTORE",
  "ALL",
  "all",
  "cap_sys_admin",
  "CAP_SYS_ADMIN",
  "Cap_Net_Admin",
];

const ALLOWED_CAPS = [
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
  "IPC_LOCK",
  "cap_ipc_lock",
  "SYS_NICE",
];

describe("create policy: capabilities", () => {
  it.each(DENIED_CAPS)("denies CapAdd %s", async (cap) => {
    const r = await create({ Image: "alpine", HostConfig: { CapAdd: ["CHOWN", cap] } }, "");

    await expectRejected(r, 403);
    expect(message(r)).toContain(cap);
  });

  it.each(ALLOWED_CAPS)("allows CapAdd %s under sysbox-runc", async (cap) => {
    const r = await create({ Image: "alpine", HostConfig: { CapAdd: [cap] } }, "");

    expect(r.status, r.body).toBe(201);
    expect(forwarded().HostConfig.CapAdd).toEqual([cap]);
  });

  it("denies SYS_NICE under runc", async () => {
    const runc = await proxy.registerTask({
      ...SCOPE,
      taskId: "019d0000-0000-7000-8000-0000000000c3",
      runtime: "runc",
    });
    const r = await requestOverSocket(runc, {
      method: "POST",
      path: "/containers/create",
      body: JSON.stringify({ Image: "alpine", HostConfig: { CapAdd: ["SYS_NICE"] } }),
    });

    await expectRejected(r, 403);
    expect(message(r)).toContain("SYS_NICE");
  });

  it("allows Docker's defaults and IPC_LOCK under runc", async () => {
    const runc = await proxy.registerTask({
      ...SCOPE,
      taskId: "019d0000-0000-7000-8000-0000000000c7",
      runtime: "runc",
    });
    const r = await requestOverSocket(runc, {
      method: "POST",
      path: "/containers/create",
      body: JSON.stringify({ Image: "alpine", HostConfig: { CapAdd: ["CHOWN", "cap_ipc_lock"] } }),
    });

    expect(r.status, r.body).toBe(201);
    expect(forwarded().HostConfig.CapAdd).toEqual(["CHOWN", "cap_ipc_lock"]);
  });

  it("forwards the scope's runtime, runc included", async () => {
    const runc = await proxy.registerTask({
      ...SCOPE,
      taskId: "019d0000-0000-7000-8000-0000000000c4",
      runtime: "runc",
    });
    const r = await requestOverSocket(runc, {
      method: "POST",
      path: "/containers/create",
      body: JSON.stringify({ Image: "alpine", HostConfig: { Runtime: "sysbox-runc" } }),
    });

    expect(r.status, r.body).toBe(201);
    expect(forwarded().HostConfig.Runtime).toBe("runc");
  });

  it("labels a child one deeper than its parent", async () => {
    const nested = await proxy.registerTask({
      ...SCOPE,
      taskId: "019d0000-0000-7000-8000-0000000000c5",
      parentDepth: 1,
    });
    const r = await requestOverSocket(nested, {
      method: "POST",
      path: "/containers/create",
      body: JSON.stringify({ Image: "alpine", Labels: { "cogmo.depth": "0" } }),
    });

    expect(r.status, r.body).toBe(201);
    expect(forwarded().Labels["cogmo.depth"]).toBe("2");
  });

  it("allows CapDrop of anything", async () => {
    const r = await create({ Image: "alpine", HostConfig: { CapDrop: ["ALL"] } }, "");

    expect(r.status, r.body).toBe(201);
    expect(forwarded().HostConfig.CapDrop).toEqual(["ALL"]);
  });
});

describe("create policy: resources", () => {
  it("injects every limit into a create that sets none", async () => {
    const r = await create({ Image: "alpine" }, "");

    expect(r.status, r.body).toBe(201);
    expect(forwarded().HostConfig).toMatchObject({
      Memory: GIB,
      MemorySwap: GIB,
      PidsLimit: 256,
      NanoCpus: 2_000_000_000,
    });
  });

  it.each([
    ["Memory", "Memory", GIB],
    ["PidsLimit", "PidsLimit", 256],
    ["NanoCpus", "NanoCpus", 2_000_000_000],
  ])("%s at 0 is injected", async (field, read, injected) => {
    const r = await create({ Image: "alpine", HostConfig: { [field]: 0 } }, "");

    expect(r.status, r.body).toBe(201);
    expect(forwarded().HostConfig[read]).toBe(injected);
  });

  it.each([
    ["Memory", GIB],
    ["PidsLimit", 256],
    ["NanoCpus", 2_000_000_000],
  ])("%s at null is injected as %d", async (field, injected) => {
    const r = await create({ Image: "alpine", HostConfig: { [field]: null } }, "");

    expect(r.status, r.body).toBe(201);
    expect(forwarded().HostConfig[field]).toBe(injected);
  });

  it.each([
    ["Memory", GIB],
    ["PidsLimit", 256],
    ["NanoCpus", 2_000_000_000],
    ["Memory", 64 * 1024 ** 2],
    ["NanoCpus", 500_000_000],
  ])("%s = %d is within the limit", async (field, value) => {
    const r = await create({ Image: "alpine", HostConfig: { [field]: value } }, "");

    expect(r.status, r.body).toBe(201);
    expect(forwarded().HostConfig[field]).toBe(value);
  });

  it.each([
    ["Memory", GIB + 1],
    ["PidsLimit", 257],
    ["NanoCpus", 2_000_000_001],
    ["Memory", -1],
    ["PidsLimit", -1],
    ["NanoCpus", -1],
    ["CpuQuota", -1],
    ["CpuQuota", 200_001],
  ])("%s = %d is denied", async (field, value) => {
    const r = await create({ Image: "alpine", HostConfig: { [field]: value } }, "");

    await expectRejected(r, 403);
    expect(message(r)).toContain(field);
  });

  it("sets an absent or zero MemorySwap to the effective Memory", async () => {
    const absent = await create({ Image: "alpine", HostConfig: { Memory: 512 * 1024 ** 2 } }, "");
    expect(absent.status, absent.body).toBe(201);
    expect(forwarded().HostConfig.MemorySwap).toBe(512 * 1024 ** 2);
  });

  it("sets a zero MemorySwap to the injected Memory", async () => {
    const r = await create({ Image: "alpine", HostConfig: { MemorySwap: 0 } }, "");

    expect(r.status, r.body).toBe(201);
    expect(forwarded().HostConfig.MemorySwap).toBe(GIB);
  });

  it("allows a MemorySwap equal to Memory", async () => {
    const r = await create({ Image: "alpine", HostConfig: { Memory: GIB, MemorySwap: GIB } }, "");

    expect(r.status, r.body).toBe(201);
    expect(forwarded().HostConfig.MemorySwap).toBe(GIB);
  });

  it.each([
    [{ Memory: 0, MemorySwap: -1 }],
    [{ MemorySwap: -1 }],
    [{ Memory: 512 * 1024 ** 2, MemorySwap: GIB }],
  ])("denies MemorySwap other than Memory: %j", async (host) => {
    const r = await create({ Image: "alpine", HostConfig: host }, "");

    await expectRejected(r, 403);
    expect(message(r)).toContain("MemorySwap");
  });

  it.each([
    ["CpuQuota without CpuPeriod at the limit", { CpuQuota: 200_000 }],
    ["CpuQuota with CpuPeriod at the limit", { CpuQuota: 100_000, CpuPeriod: 50_000 }],
    ["CpuQuota with CpuPeriod under the limit", { CpuQuota: 50_000, CpuPeriod: 100_000 }],
  ])("allows %s, without injecting NanoCpus", async (_label, host) => {
    const r = await create({ Image: "alpine", HostConfig: host }, "");

    expect(r.status, r.body).toBe(201);
    const fwd = forwarded().HostConfig;
    expect(fwd).toMatchObject(host);
    expect(fwd).not.toHaveProperty("NanoCpus");
  });

  it("denies CpuQuota over CpuPeriod above the limit", async () => {
    const r = await create(
      { Image: "alpine", HostConfig: { CpuQuota: 100_001, CpuPeriod: 50_000 } },
      "",
    );

    await expectRejected(r, 403);
  });

  it("denies a negative CpuPeriod beside CpuQuota", async () => {
    const r = await create(
      { Image: "alpine", HostConfig: { CpuQuota: 50_000, CpuPeriod: -1 } },
      "",
    );

    await expectRejected(r, 403);
    expect(message(r)).toContain("CpuPeriod");
  });

  it.each([
    ["alone", { CpuPeriod: -1 }],
    ["beside NanoCpus", { CpuPeriod: -1, NanoCpus: 1_000_000_000 }],
  ])("denies a negative CpuPeriod %s", async (_label, host) => {
    const r = await create({ Image: "alpine", HostConfig: host }, "");

    await expectRejected(r, 403);
    expect(message(r)).toContain("CpuPeriod");
  });

  it.each([
    [50_000, 201],
    [50_001, 403],
  ])("compares CpuQuota %d against a half-CPU task exactly", async (quota, status) => {
    const half = await proxy.registerTask({
      ...SCOPE,
      taskId: "019d0000-0000-7000-8000-0000000000c6",
      resourceLimits: { ...SCOPE.resourceLimits, cpus: 0.5 },
    });
    const r = await requestOverSocket(half, {
      method: "POST",
      path: "/containers/create",
      body: JSON.stringify({
        Image: "alpine",
        HostConfig: { CpuQuota: quota, CpuPeriod: 0, MemorySwap: null },
      }),
    });

    expect(r.status, r.body).toBe(status);
    if (status === 201) {
      const host = forwarded().HostConfig;
      expect(host.CpuQuota).toBe(quota);
      expect(host).not.toHaveProperty("CpuPeriod");
      expect(host).not.toHaveProperty("NanoCpus");
      expect(host.MemorySwap).toBe(GIB);
    } else {
      expect(daemon.requests()).toEqual([]);
    }
  });

  it("denies NanoCpus with CpuQuota", async () => {
    const r = await create(
      { Image: "alpine", HostConfig: { NanoCpus: 1_000_000_000, CpuQuota: 50_000 } },
      "",
    );

    await expectRejected(r, 403);
    expect(message(r)).toContain("NanoCpus");
  });

  it("drops a CpuPeriod without CpuQuota and injects NanoCpus", async () => {
    const r = await create({ Image: "alpine", HostConfig: { CpuPeriod: 50_000 } }, "");

    expect(r.status, r.body).toBe(201);
    const fwd = forwarded().HostConfig;
    expect(fwd).not.toHaveProperty("CpuPeriod");
    expect(fwd.NanoCpus).toBe(2_000_000_000);
  });

  it("drops a CpuPeriod beside NanoCpus", async () => {
    const r = await create(
      { Image: "alpine", HostConfig: { NanoCpus: 1_000_000_000, CpuPeriod: 50_000 } },
      "",
    );

    expect(r.status, r.body).toBe(201);
    const fwd = forwarded().HostConfig;
    expect(fwd).not.toHaveProperty("CpuPeriod");
    expect(fwd.NanoCpus).toBe(1_000_000_000);
  });

  it("allows ShmSize up to the effective Memory and denies it above", async () => {
    const at = await create({ Image: "alpine", HostConfig: { ShmSize: GIB } }, "");
    expect(at.status, at.body).toBe(201);
    expect(forwarded().HostConfig.ShmSize).toBe(GIB);

    const above = await create(
      { Image: "alpine", HostConfig: { Memory: 128 * 1024 ** 2, ShmSize: 256 * 1024 ** 2 } },
      "",
    );
    expect(above.status, above.body).toBe(403);
    expect(message(above)).toContain("ShmSize");
    expect(creates()).toHaveLength(1);
  });

  it.each([
    ["MemoryReservation", 1024],
    ["MemorySwappiness", 10],
    ["CpuShares", 512],
    ["CpusetCpus", "0-1"],
    ["CpusetMems", "0"],
    ["OomScoreAdj", 500],
    ["OomScoreAdj", 0],
  ])("allows %s = %j", async (field, value) => {
    const r = await create({ Image: "alpine", HostConfig: { [field]: value } }, "");

    expect(r.status, r.body).toBe(201);
    expect(forwarded().HostConfig[field]).toEqual(value);
  });

  it("denies a negative OomScoreAdj", async () => {
    const r = await create({ Image: "alpine", HostConfig: { OomScoreAdj: -1 } }, "");

    await expectRejected(r, 403);
    expect(message(r)).toContain("OomScoreAdj");
  });
});

describe("create policy: host options with value rules", () => {
  it.each([
    [
      "Ulimits",
      [
        { Name: "nofile", Soft: 1024, Hard: 4096 },
        { Name: "nproc", Soft: 64, Hard: 64 },
      ],
    ],
    ["SecurityOpt", ["no-new-privileges", "no-new-privileges:true", "no-new-privileges=true"]],
    ["RestartPolicy", { Name: "on-failure", MaximumRetryCount: 3 }],
    ["RestartPolicy", { Name: "no", MaximumRetryCount: 0 }],
    ["RestartPolicy", { Name: "", MaximumRetryCount: 0 }],
    ["IpcMode", "private"],
    ["IpcMode", "shareable"],
    ["IpcMode", "none"],
    ["IpcMode", ""],
    ["CgroupnsMode", "private"],
    ["CgroupnsMode", ""],
    ["GroupAdd", ["audio"]],
    ["Init", true],
    ["ReadonlyRootfs", true],
    ["AutoRemove", true],
    ["ExtraHosts", ["host.testcontainers.internal:172.17.0.3"]],
    ["Dns", ["1.1.1.1"]],
    ["DnsOptions", ["ndots:1"]],
    ["DnsSearch", ["example.com"]],
    ["ConsoleSize", [24, 80]],
    ["Tmpfs", { "/run": "rw,size=64m" }],
    [
      "Mounts",
      [{ Type: "tmpfs", Target: "/scratch", TmpfsOptions: { SizeBytes: 1024, Mode: 1777 } }],
    ],
    ["Binds", []],
    ["Binds", null],
  ])("allows HostConfig.%s = %j", async (field, value) => {
    const r = await create({ Image: "alpine", HostConfig: { [field]: value } }, "");

    expect(r.status, r.body).toBe(201);
    expect(forwarded().HostConfig[field]).toEqual(value);
  });

  it.each([
    ["Ulimits", [{ Name: "memlock", Soft: -1, Hard: -1 }], "memlock"],
    ["SecurityOpt", ["seccomp=unconfined"], "seccomp=unconfined"],
    ["SecurityOpt", ["apparmor=unconfined"], "apparmor=unconfined"],
    ["SecurityOpt", ["label=disable"], "label=disable"],
    ["SecurityOpt", ["systempaths=unconfined"], "systempaths=unconfined"],
    ["SecurityOpt", ["no-new-privileges:false"], "no-new-privileges:false"],
    ["RestartPolicy", { Name: "always" }, "always"],
    ["RestartPolicy", { Name: "unless-stopped" }, "unless-stopped"],
    ["Binds", ["/etc:/host-etc"], "Binds"],
    ["Binds", ["/var/run/docker.sock:/var/run/docker.sock"], "Binds"],
    ["Binds", ["cogmo-task-home-other:/home"], "Binds"],
    ["Binds", ["myvol:/data:ro"], "Binds"],
    ["Mounts", [{ Type: "bind", Source: "/etc", Target: "/host-etc" }], "Mounts"],
    ["Mounts", [{ Type: "volume", Source: "cogmo-task-home-other", Target: "/home" }], "Mounts"],
    ["Mounts", [{ Type: "volume", Target: "/anon" }], "volume"],
    ["Mounts", [{ Type: "image", Source: "alpine", Target: "/img" }], "Mounts"],
    ["Mounts", [{ Type: "npipe", Source: "x", Target: "/x" }], "Mounts"],
    ["Mounts", [{ Type: "TMPFS", Target: "/x" }], "TMPFS"],
  ])("denies HostConfig.%s = %j", async (field, value, named) => {
    const r = await create({ Image: "alpine", HostConfig: { [field]: value } }, "");

    await expectRejected(r, 403);
    expect(message(r)).toContain(named);
  });

  it("overwrites Runtime and CgroupParent from the scope", async () => {
    const r = await create(
      { Image: "alpine", HostConfig: { Runtime: "runc", CgroupParent: "/elsewhere" } },
      "",
    );

    expect(r.status, r.body).toBe(201);
    expect(forwarded().HostConfig).toMatchObject({
      Runtime: "sysbox-runc",
      CgroupParent: "cogmo-task-abc.slice",
    });
  });
});

describe("create policy: networks", () => {
  it.each(["", "default", "bridge", "none"])("allows NetworkMode %j", async (mode) => {
    const r = await create({ Image: "alpine", HostConfig: { NetworkMode: mode } }, "");

    expect(r.status, r.body).toBe(201);
    expect(forwarded().HostConfig.NetworkMode).toBe(mode);
  });

  it.each(["host", "container:sibling", "my-network", "Bridge"])(
    "denies NetworkMode %j",
    async (mode) => {
      const r = await create({ Image: "alpine", HostConfig: { NetworkMode: mode } }, "");

      await expectRejected(r, 403);
      expect(message(r)).toContain("NetworkMode");
    },
  );

  it.each(["default", "bridge", "none"])(
    "allows an EndpointsConfig key %s with Aliases",
    async (key) => {
      const endpoints = { [key]: { Aliases: ["db"] } };
      const r = await create(
        { Image: "alpine", NetworkingConfig: { EndpointsConfig: endpoints } },
        "",
      );

      expect(r.status, r.body).toBe(201);
      expect(dig(forwarded(), ["NetworkingConfig", "EndpointsConfig"])).toEqual(endpoints);
    },
  );

  it.each(["my-network", "host", "cogmo-other"])(
    "denies an EndpointsConfig key %s",
    async (key) => {
      const r = await create(
        { Image: "alpine", NetworkingConfig: { EndpointsConfig: { [key]: {} } } },
        "",
      );

      await expectRejected(r, 403);
      expect(message(r)).toContain(key);
    },
  );

  it("rewrites PortBindings to the bridge gateway", async () => {
    const r = await create(
      {
        Image: "alpine",
        ExposedPorts: { "5432/tcp": {}, "8080/tcp": {}, "53/udp": {} },
        HostConfig: {
          PortBindings: {
            "5432/tcp": [{ HostPort: "0" }],
            "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "" }],
            "53/udp": [{ HostIp: "::", HostPort: "0" }],
          },
        },
      },
      "",
    );

    expect(r.status, r.body).toBe(201);
    expect(forwarded().HostConfig.PortBindings).toEqual({
      "5432/tcp": [{ HostIp: GATEWAY, HostPort: "0" }],
      "8080/tcp": [{ HostIp: GATEWAY, HostPort: "" }],
      "53/udp": [{ HostIp: GATEWAY, HostPort: "0" }],
    });
  });

  it("binds published ports to loopback on a rootless daemon, without reading the bridge", async () => {
    // RootlessKit listens in the host's network namespace, where the bridge
    // gateway is not an address.
    daemon.setResponder(createApi({ arch: "amd64", rootless: true }));

    const r = await create(
      {
        Image: "alpine",
        ExposedPorts: { "5432/tcp": {} },
        HostConfig: { PortBindings: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "0" }] } },
      },
      "",
    );

    expect(r.status, r.body).toBe(201);
    expect(forwarded().HostConfig.PortBindings).toEqual({
      "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }],
    });
    expect(daemon.requests().filter((req) => req.url === "/networks/bridge")).toEqual([]);
  });

  it.each(["8080", "8080-8081", " 0"])("denies a fixed HostPort %j", async (port) => {
    const r = await create(
      { Image: "alpine", HostConfig: { PortBindings: { "80/tcp": [{ HostPort: port }] } } },
      "",
    );

    await expectRejected(r, 403);
    expect(message(r)).toContain("HostPort");
  });

  it("skips the gateway lookup when nothing is published", async () => {
    const r = await create({ Image: "alpine", HostConfig: { PortBindings: { "80/tcp": [] } } }, "");

    expect(r.status, r.body).toBe(201);
    expect(daemon.requests().map((q) => q.url)).not.toContainEqual(
      expect.stringContaining("/networks/"),
    );
  });
});

describe("create policy: values kept as sent", () => {
  it("forwards the rebuilt body as JSON whatever content type the client sent", async () => {
    const r = await requestOverSocket(socket, {
      method: "POST",
      path: "/containers/create",
      body: JSON.stringify({ Image: "alpine" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(r.status, r.body).toBe(201);
    const [only] = creates();
    expect(expectDefined(only, "create").headers["content-type"]).toBe("application/json");
  });

  it("forwards data-keyed maps, empty values and an empty Entrypoint unchanged", async () => {
    const body = {
      Image: "alpine",
      Entrypoint: [""],
      Cmd: ["sleep", "1"],
      ExposedPorts: { "5432/tcp": {} },
      Volumes: { "/data": {} },
      Labels: { empty: "", "org.testcontainers": "true" },
      HostConfig: { Tmpfs: { "/tmp": "" }, AutoRemove: false, PortBindings: {} },
    };
    const r = await create(body, "");

    expect(r.status, r.body).toBe(201);
    const fwd = forwarded();
    expect(fwd.Entrypoint).toEqual([""]);
    expect(fwd.Cmd).toEqual(["sleep", "1"]);
    expect(fwd.ExposedPorts).toEqual({ "5432/tcp": {} });
    expect(fwd.Volumes).toEqual({ "/data": {} });
    expect(fwd.Labels).toMatchObject({ empty: "", "org.testcontainers": "true" });
    expect(fwd.HostConfig).toMatchObject({
      Tmpfs: { "/tmp": "" },
      AutoRemove: false,
      PortBindings: {},
    });
  });

  it.each([
    ["Cmd", ["sh", "-c", "true"]],
    ["WorkingDir", "/srv"],
    ["User", "1000:1000"],
    ["Hostname", "db"],
    ["Domainname", "example.com"],
    ["StopSignal", "SIGINT"],
    ["StopTimeout", 5],
    ["Shell", ["/bin/bash", "-c"]],
    ["Tty", true],
    ["OpenStdin", true],
    ["StdinOnce", true],
    ["AttachStdin", true],
    ["AttachStdout", true],
    ["AttachStderr", true],
    ["NetworkDisabled", true],
    [
      "Healthcheck",
      {
        Test: ["CMD", "true"],
        Interval: 1e9,
        Timeout: 1e9,
        Retries: 3,
        StartPeriod: 0,
        StartInterval: 0,
      },
    ],
  ])("forwards %s", async (field, value) => {
    const r = await create({ Image: "alpine", [field]: value }, "");

    expect(r.status, r.body).toBe(201);
    expect(forwarded()[field]).toEqual(value);
  });
});

describe("create policy: the image", () => {
  it("forwards the inspected Id in place of Image", async () => {
    const r = await create({ Image: "alpine" }, "");

    expect(r.status, r.body).toBe(201);
    expect(forwarded().Image).toBe(ALPINE_ID);
  });

  it("answers an image the daemon does not have with 404, without a create", async () => {
    const r = await create({ Image: "nonexistent:latest" }, "");

    expect(r.status, r.body).toBe(404);
    expect(message(r)).toContain("No such image: nonexistent:latest");
    expect(creates()).toEqual([]);
  });

  it("denies an image whose Config.Env has a SYSBOX_ key, without a create", async () => {
    const r = await create({ Image: "sysbox-tuned" }, "");

    expect(r.status, r.body).toBe(403);
    expect(message(r)).toContain("SYSBOX_");
    expect(creates()).toEqual([]);
  });

  it.each(["../containers/x", "alpine?x=1", "a#b", "a b", "a\\b", ""])(
    "rejects the Image reference %j without a lookup",
    async (image) => {
      const r = await create({ Image: image }, "");

      expect(r.status, r.body).toBe(400);
      expect(daemon.requests()).toEqual([]);
    },
  );
});

describe("create policy: the query", () => {
  it("drops a body name and forwards the query name", async () => {
    const r = await create({ Image: "alpine", name: "from-body" }, "?name=from-query");

    expect(r.status, r.body).toBe(201);
    const [only] = creates();
    expect(expectDefined(only, "create").url).toBe("/containers/create?name=from-query");
    expect(forwarded()).not.toHaveProperty("name");
  });

  it("forwards a non-canonical create path canonicalised, without empty or unread query keys", async () => {
    const r = await createRaw(
      JSON.stringify({ Image: "alpine" }),
      "/v1.44//containers/./create?name=&platform=&ignored=1",
    );

    expect(r.status, r.body).toBe(201);
    expect(expectDefined(creates()[0], "create").url).toBe("/v1.44/containers/create");
  });

  it("drops every query key but name and platform", async () => {
    const r = await create(
      { Image: "alpine", platform: "linux/arm64" },
      "?Image=evil&HostConfig=%7B%22Privileged%22%3Atrue%7D&name=db&platform=linux%2Famd64&foo=1",
    );

    expect(r.status, r.body).toBe(201);
    const [only] = creates();
    expect(expectDefined(only, "create").url).toBe(
      "/containers/create?name=db&platform=linux%2Famd64",
    );
    expect(forwarded()).not.toHaveProperty("platform");
  });

  it("passes the recorded testcontainers create, changed only by the policy", async () => {
    const req = TESTCONTAINERS_CREATE_REQUEST;
    const r = await requestOverSocket(socket, {
      method: req.method,
      path: req.path,
      body: req.body,
      headers: { ...req.headers },
    });

    expect(r.status, r.body).toBe(201);
    const [only] = creates();
    const sent = expectDefined(only, "create");
    expect(sent.url).toBe("/containers/create?name=cogmo-capture-postgres");
    expect(sent.headers["user-agent"]).toBe("tc-node/12.2.1");
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(sent.body)).toEqual({
      Image: POSTGRES_ID,
      ExposedPorts: { "5432/tcp": {} },
      Env: ["POSTGRES_USER=cogmo", "POSTGRES_DB=cogmo", "POSTGRES_HOST_AUTH_METHOD=trust"],
      Labels: {
        "org.testcontainers": "true",
        "org.testcontainers.lang": "node",
        "org.testcontainers.version": "12.2.1",
        "org.testcontainers.session-id": "a4baacb648e3",
        "cogmo.managed": "true",
        "cogmo.instance": SCOPE.instanceId,
        "cogmo.root_task": SCOPE.taskId,
        "cogmo.parent": ANCHOR.dockerId,
        "cogmo.depth": "1",
      },
      HostConfig: {
        AutoRemove: false,
        PortBindings: { "5432/tcp": [{ HostIp: GATEWAY, HostPort: "0" }] },
        Runtime: "sysbox-runc",
        CgroupParent: "cogmo-task-abc.slice",
        Memory: GIB,
        MemorySwap: GIB,
        PidsLimit: 256,
        NanoCpus: 2_000_000_000,
      },
    });
  });
});

describe("create policy: the Docker CLI", () => {
  it("passes the recorded Docker CLI create, changed only by the policy", async () => {
    const req = DOCKER_CLI_CREATE_REQUEST;
    const r = await requestOverSocket(socket, {
      method: req.method,
      path: req.path,
      body: req.body,
      headers: { ...req.headers },
    });

    expect(r.status, r.body).toBe(201);
    const [only] = creates();
    const sent = expectDefined(only, "create");
    expect(sent.url).toBe("/v1.51/containers/create?name=pg-test");
    expect(JSON.parse(sent.body)).toEqual({
      Hostname: "",
      Domainname: "",
      User: "",
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      ExposedPorts: { "5432/tcp": {} },
      Tty: false,
      OpenStdin: false,
      StdinOnce: false,
      Env: ["POSTGRES_PASSWORD=x"],
      Cmd: null,
      Image: POSTGRES_ALPINE_ID,
      Volumes: {},
      WorkingDir: "",
      Entrypoint: null,
      Labels: {
        "cogmo.managed": "true",
        "cogmo.instance": SCOPE.instanceId,
        "cogmo.root_task": SCOPE.taskId,
        "cogmo.parent": ANCHOR.dockerId,
        "cogmo.depth": "1",
      },
      HostConfig: {
        Binds: null,
        NetworkMode: "default",
        PortBindings: { "5432/tcp": [{ HostIp: GATEWAY, HostPort: "" }] },
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        AutoRemove: false,
        ConsoleSize: [0, 0],
        CapAdd: null,
        CapDrop: null,
        CgroupnsMode: "",
        Dns: null,
        DnsOptions: [],
        DnsSearch: [],
        ExtraHosts: null,
        GroupAdd: null,
        IpcMode: "",
        OomScoreAdj: 0,
        ReadonlyRootfs: false,
        SecurityOpt: null,
        ShmSize: 0,
        CpuShares: 0,
        CpusetCpus: "",
        CpusetMems: "",
        MemoryReservation: 0,
        MemorySwappiness: -1,
        Ulimits: null,
        Runtime: "sysbox-runc",
        CgroupParent: "cogmo-task-abc.slice",
        Memory: GIB,
        MemorySwap: GIB,
        PidsLimit: 256,
        NanoCpus: 2_000_000_000,
      },
      NetworkingConfig: { EndpointsConfig: { default: { Aliases: null } } },
    });
  });
});

describe("create policy: platform", () => {
  it.each([
    "linux",
    "Linux/x86_64",
    "linux/amd64",
    "amd64",
    "LINUX/AMD64",
    "linux/x86-64",
    "linux/amd64/v1",
  ])("forwards the host platform form %s on amd64", async (platform) => {
    const r = await create({ Image: "alpine" }, `?platform=${encodeURIComponent(platform)}`);

    expect(r.status, r.body).toBe(201);
    const [only] = creates();
    const url = new URL(expectDefined(only, "create").url, "http://docker");
    expect(url.searchParams.get("platform")).toBe(platform);
  });

  it("treats an empty platform as absent", async () => {
    const r = await create({ Image: "alpine" }, "?platform=");

    expect(r.status, r.body).toBe(201);
    expect(expectDefined(creates()[0], "create").url).toBe("/containers/create");
  });

  it.each([
    "linux/arm64",
    "linux/amd64/v2",
    "windows/amd64",
    "linux/386",
    "arm64",
    "darwin",
    "linux(5.15)/amd64",
    "linux/amd64/v1/extra",
    "linux/*",
    "/amd64",
    "freebsd",
    "macos/amd64",
    "linux//amd64",
    "linux/amd64/",
    "linux/amd64/../v1",
    "linux(6.1+feature)/amd64",
    "riscv64",
    "not-an-os-or-arch",
  ])("denies the non-host platform %s on amd64, without a create", async (platform) => {
    const r = await create({ Image: "alpine" }, `?platform=${encodeURIComponent(platform)}`);

    expect(r.status, r.body).toBe(403);
    expect(message(r)).toContain("platform");
    expect(creates()).toEqual([]);
  });

  describe("on an arm64 daemon", () => {
    beforeEach(async () => {
      await daemon.close();
      await startDaemon("arm64");
    });

    it.each(["linux/arm64/v8", "linux/aarch64", "linux/arm64", "arm64", "linux", "linux/arm64/8"])(
      "forwards %s",
      async (platform) => {
        const r = await create({ Image: "alpine" }, `?platform=${encodeURIComponent(platform)}`);

        expect(r.status, r.body).toBe(201);
      },
    );

    it.each(["linux/arm64/v9", "linux/arm64/v8.2", "linux/amd64", "linux/arm/v7", "linux/armel"])(
      "denies %s",
      async (platform) => {
        const r = await create({ Image: "alpine" }, `?platform=${encodeURIComponent(platform)}`);

        expect(r.status, r.body).toBe(403);
        expect(creates()).toEqual([]);
      },
    );
  });
});

describe("create policy: API version", () => {
  it.each(["/v1.43", "/v1.24", "/v1.4", "/v1"])("denies a create under %s", async (prefix) => {
    const r = await createRaw(JSON.stringify({ Image: "alpine" }), `${prefix}/containers/create`);

    await expectRejected(r, 403);
    expect(message(r)).toContain("1.44");
  });

  it.each(["/v1.44", "/v1.52"])("forwards a create under %s with its prefix", async (prefix) => {
    const r = await createRaw(
      JSON.stringify({ Image: "alpine" }),
      `${prefix}/containers/create?name=x`,
    );

    expect(r.status, r.body).toBe(201);
    expect(expectDefined(creates()[0], "create").url).toBe(`${prefix}/containers/create?name=x`);
  });
});

/** `AMD64_API`, except that requests `matching` get `status` and `body`. */
function failing(
  matching: (req: FakeDaemonRequest) => boolean,
  status: number,
  body: unknown,
): FakeDaemonResponder {
  return (req, res, raw) =>
    matching(req) ? respondJson(res, status, body) : AMD64_API(req, res, raw);
}

const isVersion = (req: FakeDaemonRequest) => req.url === "/version";
const isInspect = (req: FakeDaemonRequest) => req.url.startsWith("/images/");
const isBridge = (req: FakeDaemonRequest) => req.url === "/networks/bridge";
const isInfo = (req: FakeDaemonRequest) => req.url === "/info";

describe("create policy: daemon lookups", () => {
  it.each([
    ["the image inspect fails", failing(isInspect, 500, { message: "boom" }), ""],
    ["the image inspect is unreadable", failing(isInspect, 200, { Config: {} }), ""],
    ["GET /version fails", failing(isVersion, 500, { message: "boom" }), "?platform=linux"],
    ["GET /version is unreadable", failing(isVersion, 200, { Os: "linux" }), "?platform=linux"],
    [
      "the bridge has no IPv4 gateway",
      failing(isBridge, 200, { IPAM: { Config: [{ Gateway: "fd00::1" }] } }),
      "",
    ],
    ["GET /networks/bridge fails", failing(isBridge, 404, { message: "no such network" }), ""],
    ["GET /info fails", failing(isInfo, 500, { message: "boom" }), ""],
    ["GET /info is unreadable", failing(isInfo, 200, { SecurityOptions: "rootless" }), ""],
  ])("answers 503 when %s, without a create", async (_label, responder, query) => {
    daemon.setResponder(responder);

    const r = await create(
      { Image: "alpine", HostConfig: { PortBindings: { "80/tcp": [{ HostPort: "0" }] } } },
      query,
    );

    expect(r.status, r.body).toBe(503);
    expect(creates()).toEqual([]);
  });

  it.each([
    [false, 2],
    [true, 0],
  ])(
    "reads GET /info once, rootless %s, with %d bridge reads over two publishing creates",
    async (rootless, bridgeReads) => {
      daemon.setResponder(createApi({ arch: "amd64", rootless }));
      const publishing = {
        Image: "alpine",
        HostConfig: { PortBindings: { "80/tcp": [{ HostPort: "0" }] } },
      };

      expect((await create(publishing, "")).status).toBe(201);
      expect((await create(publishing, "")).status).toBe(201);

      expect(daemon.requests().filter(isInfo)).toHaveLength(1);
      expect(daemon.requests().filter(isBridge)).toHaveLength(bridgeReads);
    },
  );

  it("answers a plain-text 404 from the image inspect as not_found", async () => {
    daemon.setResponder((req, res, raw) => {
      if (!isInspect(req)) return AMD64_API(req, res, raw);
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("page not found");
    });

    const r = await create({ Image: "missing:latest" }, "");

    expect(r.status, r.body).toBe(404);
    expect(message(r)).toContain("No such image: missing:latest");
    expect(creates()).toEqual([]);
  });

  it("answers 400 with the daemon's reason when the image inspect refuses the reference", async () => {
    daemon.setResponder(failing(isInspect, 400, { message: "invalid reference format" }));

    const r = await create({ Image: "alpine" }, "");

    expect(r.status, r.body).toBe(400);
    expect(message(r)).toContain("invalid reference format");
    expect(creates()).toEqual([]);
  });

  it("answers 503 when a lookup reply is not JSON", async () => {
    daemon.setResponder((req, res, raw) => {
      if (!isInspect(req)) return AMD64_API(req, res, raw);
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>proxy error</html>");
    });

    const r = await create({ Image: "alpine" }, "");

    expect(r.status, r.body).toBe(503);
    expect(message(r)).toContain("not JSON");
    expect(creates()).toEqual([]);
  });

  it("answers 503 when a lookup reply is over 4 MiB", async () => {
    const env = [`BIG=${"x".repeat(5 * 1024 * 1024)}`];
    daemon.setResponder(failing(isInspect, 200, { Id: ALPINE_ID, Config: { Env: env } }));

    const r = await create({ Image: "alpine" }, "");

    expect(r.status, r.body).toBe(503);
    expect(message(r)).toContain("exceeds");
    expect(creates()).toEqual([]);
  });

  it("answers 503 when the daemon is unreachable for a lookup", async () => {
    await daemon.close();

    const r = await create({ Image: "alpine" }, "");

    expect(r.status, r.body).toBe(503);
  });

  it("reads the daemon's platform once", async () => {
    await create({ Image: "alpine" }, "?platform=linux/amd64");
    await create({ Image: "alpine" }, "?platform=linux");

    expect(daemon.requests().filter(isVersion)).toHaveLength(1);
    expect(creates()).toHaveLength(2);
  });

  it("reads the daemon's platform again after a failed read", async () => {
    daemon.setResponder(failing(isVersion, 500, { message: "boom" }));
    const failed = await create({ Image: "alpine" }, "?platform=linux");
    expect(failed.status, failed.body).toBe(503);

    daemon.setResponder(AMD64_API);
    const passed = await create({ Image: "alpine" }, "?platform=linux");

    expect(passed.status, passed.body).toBe(201);
    expect(daemon.requests().filter(isVersion)).toHaveLength(2);
  });

  it("does not read the daemon's platform for a create that names none", async () => {
    const r = await create({ Image: "alpine" }, "");

    expect(r.status, r.body).toBe(201);
    expect(daemon.requests().filter(isVersion)).toEqual([]);
  });

  it("reads the bridge gateway on every create that publishes a port", async () => {
    const publishing = {
      Image: "alpine",
      HostConfig: { PortBindings: { "80/tcp": [{ HostPort: "0" }] } },
    };
    await create(publishing, "");
    await create(publishing, "");

    expect(daemon.requests().filter(isBridge)).toHaveLength(2);
  });

  it("forwards an image with no Config.Env", async () => {
    daemon.setResponder(failing(isInspect, 200, { Id: ALPINE_ID, Config: { Env: null } }));

    const r = await create({ Image: "alpine" }, "");

    expect(r.status, r.body).toBe(201);
    expect(forwarded().Image).toBe(ALPINE_ID);
  });

  it("answers 502 when the daemon connection fails for the create itself", async () => {
    daemon.setResponder((req, res, raw) => {
      if (req.url.startsWith("/containers/create")) {
        raw.socket.destroy();
        return;
      }
      AMD64_API(req, res, raw);
    });

    const r = await create({ Image: "alpine" }, "");

    expect(r.status, r.body).toBe(502);
  });
});
