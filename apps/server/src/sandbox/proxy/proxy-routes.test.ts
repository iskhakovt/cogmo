import { mkdtemp, rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import { expectDefined } from "../../test/assertions.js";
import {
  BRIDGE_NETWORK,
  dockerApi,
  type FakeContainer,
  type FakeDaemonResponder,
  type FakeDockerDaemon,
  type FakeNetwork,
  requestOverSocket,
  respondJson,
  type SocketResponse,
  startFakeDockerDaemon,
} from "../../test/fake-docker-daemon.js";
import {
  TESTCONTAINERS_BRIDGE_CONNECT_REQUEST,
  TESTCONTAINERS_CONTAINER_REQUESTS,
  TESTCONTAINERS_EXEC_REQUESTS,
} from "../../test/testcontainers-requests.js";
import { CogmoSocketProxy } from "./index.js";
import type { ContainerRows, TaskScope } from "./types.js";

const TASK_ID = "019d0000-0000-7000-8000-00000000aaaa";
const SIBLING_TASK_ID = "019d0000-0000-7000-8000-00000000cccc";

function containerId(lead: string): string {
  return `${lead}${"0".repeat(64 - lead.length)}`;
}

/** The task's depth-0 container. */
const OWN: FakeContainer = {
  id: containerId("1a"),
  name: "cogmo-task-own",
  labels: { "cogmo.root_task": TASK_ID },
};
/** A child with a depth-1 row, as the task's children carry from slice 3 on. */
const CHILD: FakeContainer = {
  id: containerId("2b"),
  name: "own-child",
  labels: { "cogmo.root_task": TASK_ID },
};
const SIBLING: FakeContainer = {
  id: containerId("3c"),
  name: "cogmo-task-sibling",
  labels: { "cogmo.root_task": SIBLING_TASK_ID },
};
/** A container Cogmo runs for itself, such as a skills worker. */
const COGMO_OWN: FakeContainer = {
  id: containerId("4d"),
  name: "cogmo-skills-worker",
  labels: { "cogmo.managed": "true" },
};
/** The containers the recorded testcontainers requests name, owned by the task. */
const RECORDED: FakeContainer = {
  id: "477cdbd59ea8e4d2fe700c1a771344e7ee9162a6ad10ccbee9f81ddc7b1fe880",
  name: "capture-alpine",
  labels: { "cogmo.root_task": TASK_ID },
};
const UNKNOWN_ID = containerId("9f");

const RECORDED_BRIDGE: FakeNetwork = {
  id: "8410490959e2f636b23cdb92ee4452b0e991c0ac62ff8f4011291227641c721c",
  name: "bridge",
};
const TASK_NETWORK: FakeNetwork = { id: containerId("5e"), name: "task-net" };
const HOST_NETWORK: FakeNetwork = { id: containerId("6f"), name: "host" };

const SCOPE: TaskScope = {
  taskId: TASK_ID,
  parentContainerRowId: "019d0000-0000-7000-8000-00000000bbbb",
  parentDockerId: OWN.id,
  parentDepth: 0,
  runtime: "sysbox-runc",
  cgroupParent: "cogmo-task-abc.slice",
  instanceId: "019d0000-0000-7000-8000-0000000000ff",
  resourceLimits: { cpus: 2, memory_bytes: 1024 ** 3, pids: 256 },
};

const ErrorSchema = z.object({ message: z.string() });
const ListSchema = z.array(z.looseObject({ Id: z.string() }));
const ExecCreatedSchema = z.object({ Id: z.string() });

function api(networks: ReadonlyArray<FakeNetwork>): FakeDaemonResponder {
  return dockerApi({
    images: new Map([["alpine:3", { id: `sha256:${"a".repeat(64)}`, env: [] }]]),
    containers: [OWN, CHILD, SIBLING, COGMO_OWN, RECORDED],
    networks,
    arch: "amd64",
    bridgeGateway: "172.17.0.1",
    rootless: false,
  });
}

const API = api([BRIDGE_NETWORK, TASK_NETWORK, HOST_NETWORK]);

let baseDir: string;
let daemon: FakeDockerDaemon;
let proxy: CogmoSocketProxy;
let rows: ReturnType<typeof mock<ContainerRows>>;
let socket: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "cogmo-proxy-routes-"));
  daemon = await startFakeDockerDaemon(join(baseDir, "docker.sock"), API);
  rows = mock<ContainerRows>();
  rows.owned.mockImplementation(async (taskId) =>
    taskId === TASK_ID
      ? [
          { dockerId: OWN.id, depth: 0 },
          { dockerId: CHILD.id, depth: 1 },
          { dockerId: RECORDED.id, depth: 1 },
        ]
      : [{ dockerId: SIBLING.id, depth: 0 }],
  );
  proxy = await CogmoSocketProxy.create({
    socketDir: join(baseDir, "sockets"),
    hostDockerSocket: daemon.socketPath,
    containerRows: rows,
  });
  socket = await proxy.registerTask(SCOPE);
});

afterEach(async () => {
  await proxy.close();
  await daemon.close();
  await rm(baseDir, { recursive: true, force: true });
});

function send(
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<SocketResponse> {
  return requestOverSocket(socket, {
    method,
    path,
    ...(body !== undefined && { body }),
    ...(headers !== undefined && { headers }),
  });
}

/** Every request the daemon received, as `METHOD url`. */
function received(): string[] {
  return daemon.requests().map((r) => `${r.method} ${r.url}`);
}

function resolveOf(ref: string): string {
  return `GET /containers/${ref}/json`;
}

function message(r: SocketResponse): string {
  return ErrorSchema.parse(JSON.parse(r.body)).message;
}

async function expectRejected(r: SocketResponse, status: number, reached: string[]) {
  expect(r.status, r.body).toBe(status);
  expect(received()).toEqual(reached);
}

describe("container ownership", () => {
  it.each([
    ["GET", "/containers/cogmo-task-own/json", `/containers/${OWN.id}/json`],
    ["GET", "/v1.44/containers/cogmo-task-own/json", `/v1.44/containers/${OWN.id}/json`],
    ["GET", "/containers/cogmo-task-own/top?ps_args=aux", `/containers/${OWN.id}/top?ps_args=aux`],
    [
      "GET",
      "/containers/cogmo-task-own/logs?stdout=true&tail=-1",
      `/containers/${OWN.id}/logs?stdout=true&tail=-1`,
    ],
    [
      "GET",
      "/containers/cogmo-task-own/stats?stream=false",
      `/containers/${OWN.id}/stats?stream=false`,
    ],
    ["GET", "/containers/cogmo-task-own/changes", `/containers/${OWN.id}/changes`],
    ["GET", "/containers/cogmo-task-own/export", `/containers/${OWN.id}/export`],
    [
      "GET",
      "/containers/cogmo-task-own/archive?path=%2Fetc",
      `/containers/${OWN.id}/archive?path=%2Fetc`,
    ],
    [
      "HEAD",
      "/containers/cogmo-task-own/archive?path=%2Fetc",
      `/containers/${OWN.id}/archive?path=%2Fetc`,
    ],
    [
      "POST",
      "/containers/cogmo-task-own/wait?condition=not-running",
      `/containers/${OWN.id}/wait?condition=not-running`,
    ],
    [
      "POST",
      "/containers/cogmo-task-own/resize?h=24&w=80",
      `/containers/${OWN.id}/resize?h=24&w=80`,
    ],
    [
      "POST",
      "/containers/cogmo-task-own/attach?stream=1&stdout=1",
      `/containers/${OWN.id}/attach?stream=1&stdout=1`,
    ],
    [
      "GET",
      "/containers/cogmo-task-own/attach/ws?stream=1",
      `/containers/${OWN.id}/attach/ws?stream=1`,
    ],
    ["PUT", "/containers/own-child/archive?path=%2F", `/containers/${CHILD.id}/archive?path=%2F`],
    ["POST", "/containers/own-child/start", `/containers/${CHILD.id}/start`],
    ["POST", "/containers/own-child/stop?t=0", `/containers/${CHILD.id}/stop?t=0`],
    ["POST", "/containers/own-child/restart", `/containers/${CHILD.id}/restart`],
    ["POST", "/containers/own-child/kill?signal=KILL", `/containers/${CHILD.id}/kill?signal=KILL`],
    ["POST", "/containers/own-child/pause", `/containers/${CHILD.id}/pause`],
    ["POST", "/containers/own-child/unpause", `/containers/${CHILD.id}/unpause`],
    [
      "POST",
      "/containers/own-child/rename?name=other",
      `/containers/${CHILD.id}/rename?name=other`,
    ],
    ["DELETE", "/containers/own-child?force=true", `/containers/${CHILD.id}?force=true`],
  ])("forwards %s %s under the full id", async (method, path, forwarded) => {
    const r = await send(method, path);

    expect(r.status, r.body).toBe(200);
    const ref = path.includes("own-child") ? "own-child" : "cogmo-task-own";
    expect(received()).toEqual([resolveOf(ref), `${method} ${forwarded}`]);
  });

  it("forwards an exec create under the container's full id", async () => {
    const r = await send(
      "POST",
      "/containers/cogmo-task-own/exec",
      JSON.stringify({ Cmd: ["id"] }),
    );

    expect(r.status, r.body).toBe(201);
    expect(received()).toEqual([resolveOf("cogmo-task-own"), `POST /containers/${OWN.id}/exec`]);
  });

  it.each([
    ["a unique id prefix", "1a00"],
    ["the full id", OWN.id],
    ["a name", "cogmo-task-own"],
  ])("resolves %s", async (_label, ref) => {
    const r = await send("GET", `/containers/${ref}/json`);

    expect(r.status, r.body).toBe(200);
    expect(received()).toEqual([resolveOf(ref), `GET /containers/${OWN.id}/json`]);
  });

  it("forwards the canonical path and the re-serialised query, not the raw target", async () => {
    const r = await send("GET", "//containers/./cogmo-task-own//json?size=1&x=a%20b&x=c");

    expect(r.status, r.body).toBe(200);
    expect(received().at(-1)).toBe(`GET /containers/${OWN.id}/json?size=1&x=a+b&x=c`);
  });

  describe.each([
    ["a sibling task's container", SIBLING.name],
    ["a sibling task's container by id", SIBLING.id],
    ["Cogmo's own container", COGMO_OWN.id],
    ["an unknown id", UNKNOWN_ID],
    ["an ambiguous prefix", "4"],
  ])("%s", (_label, ref) => {
    it.each([
      ["GET", `/containers/${ref}/json`],
      ["GET", `/containers/${ref}/logs`],
      ["POST", `/containers/${ref}/kill`],
      ["POST", `/containers/${ref}/attach`],
      ["PUT", `/containers/${ref}/archive?path=%2F`],
      ["DELETE", `/containers/${ref}`],
    ])("gets the daemon's 404 on %s %s", async (method, path) => {
      const r = await send(method, path);

      await expectRejected(r, 404, [resolveOf(ref)]);
      expect(message(r)).toBe(`No such container: ${ref}`);
    });

    it("gets the daemon's 404 on an exec create", async () => {
      const r = await send("POST", `/containers/${ref}/exec`, JSON.stringify({ Cmd: ["id"] }));

      await expectRejected(r, 404, [resolveOf(ref)]);
      expect(message(r)).toBe(`No such container: ${ref}`);
    });
  });

  it.each([
    ["POST", "start"],
    ["POST", "stop"],
    ["POST", "restart"],
    ["POST", "kill"],
    ["POST", "pause"],
    ["POST", "unpause"],
    ["POST", "rename?name=x"],
  ])("denies %s /containers/{id}/%s on the task's own container", async (method, action) => {
    const r = await send(method, `/containers/cogmo-task-own/${action}`);

    await expectRejected(r, 403, [resolveOf("cogmo-task-own")]);
  });

  it.each([
    ["DELETE", "/containers/cogmo-task-own?force=true"],
    ["PUT", "/containers/cogmo-task-own/archive?path=%2Fworkspace"],
  ])("denies %s %s on the task's own container", async (method, path) => {
    const r = await send(method, path);

    await expectRejected(r, 403, [resolveOf("cogmo-task-own")]);
  });

  it("answers unavailable when the store read fails, before asking the daemon", async () => {
    rows.owned.mockRejectedValue(new Error("connection refused"));

    const r = await send("GET", "/containers/cogmo-task-own/json");

    await expectRejected(r, 503, []);
    expect(message(r)).not.toContain("connection refused");
  });

  it("answers unavailable while the task has no depth-0 row", async () => {
    rows.owned.mockResolvedValue([]);

    const r = await send("GET", "/containers/cogmo-task-own/json");

    await expectRejected(r, 503, []);
  });

  it("answers unavailable when the daemon resolve fails", async () => {
    daemon.setResponder((req, res, raw) =>
      req.url.endsWith("/json") && req.url.startsWith("/containers/")
        ? respondJson(res, 500, { message: "boom" })
        : API(req, res, raw),
    );

    const r = await send("GET", "/containers/cogmo-task-own/json");

    await expectRejected(r, 503, [resolveOf("cogmo-task-own")]);
  });

  it.each(TESTCONTAINERS_CONTAINER_REQUESTS)(
    "forwards the recorded testcontainers $label on an owned container",
    async ({ method, path, headers, body }) => {
      const r = await send(method, path, body, { ...headers });

      expect(r.status, r.body).toBe(200);
      expect(received()).toEqual([resolveOf(RECORDED.id), `${method} ${path}`]);
    },
  );
});

describe("exec ownership", () => {
  async function createExec(ref: string, on: string): Promise<string> {
    const r = await requestOverSocket(on, {
      method: "POST",
      path: `/containers/${ref}/exec`,
      body: JSON.stringify({ Cmd: ["id"] }),
    });
    expect(r.status, r.body).toBe(201);
    return ExecCreatedSchema.parse(JSON.parse(r.body)).Id;
  }

  it.each([
    ["GET", "json", ""],
    ["POST", "resize", "?h=24&w=80"],
    ["POST", "start", ""],
  ])("forwards %s /exec/{id}/%s for an exec this socket created", async (method, action, query) => {
    const id = await createExec("cogmo-task-own", socket);

    const r = await send(method, `/exec/${id}/${action}${query}`);

    expect(r.status, r.body).toBe(200);
    expect(received().at(-1)).toBe(`${method} /exec/${id}/${action}${query}`);
  });

  it.each([
    ["GET", "json"],
    ["POST", "resize"],
    ["POST", "start"],
  ])(
    "answers 404 to %s /exec/{id}/%s for an exec the socket did not create",
    async (method, action) => {
      const id = "e".repeat(64);

      const r = await send(method, `/exec/${id}/${action}`);

      await expectRejected(r, 404, []);
      expect(message(r)).toBe(`No such exec instance: ${id}`);
    },
  );

  it("forwards the recorded testcontainers exec create and inspect", async () => {
    const { create, inspect } = TESTCONTAINERS_EXEC_REQUESTS;
    const created = await send(create.method, create.path, create.body, { ...create.headers });
    expect(created.status, created.body).toBe(201);
    const id = ExecCreatedSchema.parse(JSON.parse(created.body)).Id;

    const path = inspect.path.replace("{id}", id);
    const r = await send(inspect.method, path, undefined, { ...inspect.headers });

    expect(r.status, r.body).toBe(200);
    expect(received()).toEqual([
      resolveOf(RECORDED.id),
      `${create.method} ${create.path}`,
      `${inspect.method} ${path}`,
    ]);
  });

  it("records no exec from a create the daemon refused", async () => {
    daemon.setResponder((req, res, raw) =>
      req.method === "POST" && req.url.endsWith("/exec")
        ? respondJson(res, 409, { message: "container is not running" })
        : API(req, res, raw),
    );

    const r = await send(
      "POST",
      "/containers/cogmo-task-own/exec",
      JSON.stringify({ Cmd: ["id"] }),
    );

    expect(r.status, r.body).toBe(409);
    expect(message(r)).toBe("container is not running");
  });

  it("keeps each task's exec ids to its own socket", async () => {
    const sibling = await proxy.registerTask({ ...SCOPE, taskId: SIBLING_TASK_ID });
    const theirs = await createExec(SIBLING.name, sibling);
    const before = received();

    const r = await send("GET", `/exec/${theirs}/json`);

    expect(r.status, r.body).toBe(404);
    expect(received()).toEqual(before);
  });

  it("matches an exec id that spans segments as the daemon routes it", async () => {
    const r = await send("GET", "/exec/dead/beef/json");

    await expectRejected(r, 404, []);
    expect(message(r)).toBe("No such exec instance: dead/beef");
  });

  it("answers 404 to an upgrade to an exec the socket did not create", async () => {
    const reply = await rawExchange(
      [
        `POST /exec/${"e".repeat(64)}/start HTTP/1.1`,
        "Host: docker",
        "Connection: Upgrade",
        "Upgrade: tcp",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"),
    );

    expect(reply).toMatch(/^HTTP\/1\.1 404 /);
    expect(received()).toEqual([]);
  });
});

describe("upgraded streams", () => {
  it("answers 404 to an upgrade to a container the task does not own", async () => {
    const reply = await rawExchange(
      [
        `POST /containers/${SIBLING.name}/attach?stream=1 HTTP/1.1`,
        "Host: docker",
        "Connection: Upgrade",
        "Upgrade: tcp",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"),
    );

    expect(reply).toMatch(/^HTTP\/1\.1 404 /);
    expect(received()).toEqual([resolveOf(SIBLING.name)]);
  });

  it("opens no daemon connection for a client that hung up during the checks", async () => {
    const release = Promise.withResolvers<void>();
    daemon.setResponder((req, res, raw) => {
      if (req.url === `/containers/cogmo-task-own/json`) {
        release.promise.then(() => API(req, res, raw));
        return;
      }
      API(req, res, raw);
    });
    const client = net.createConnection({ path: socket });
    client.on("error", () => {});
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write(
      [
        "POST /containers/cogmo-task-own/attach?stream=1 HTTP/1.1",
        "Host: docker",
        "Connection: Upgrade",
        "Upgrade: tcp",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"),
    );
    await vi.waitFor(() => expect(received()).toEqual([resolveOf("cogmo-task-own")]));

    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(received()).toEqual([resolveOf("cogmo-task-own")]);
  });

  it("replays an owned attach under the full id", async () => {
    await rawExchange(
      [
        "POST /containers/cogmo-task-own/attach?stream=1&stdout=1 HTTP/1.1",
        "Host: docker",
        "Connection: Upgrade",
        "Upgrade: tcp",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"),
    );

    expect(received()).toEqual([
      resolveOf("cogmo-task-own"),
      `POST /containers/${OWN.id}/attach?stream=1&stdout=1`,
    ]);
  });
});

describe("lists and events", () => {
  it("keeps only owned containers in GET /containers/json", async () => {
    const r = await send("GET", "/containers/json?all=1");

    expect(r.status, r.body).toBe(200);
    expect(ListSchema.parse(JSON.parse(r.body)).map((c) => c.Id)).toEqual([
      OWN.id,
      CHILD.id,
      RECORDED.id,
    ]);
    expect(received()).toEqual(["GET /containers/json?all=1"]);
    expect(r.headers["content-length"]).toBe(String(Buffer.byteLength(r.body)));
  });

  it("answers unavailable when the store read for a list fails", async () => {
    rows.owned.mockRejectedValue(new Error("db down"));

    await expectRejected(await send("GET", "/containers/json"), 503, []);
  });

  it("answers unavailable to a container list that is not JSON", async () => {
    daemon.setResponder((req, res, raw) => {
      if (req.url.startsWith("/containers/json")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[{");
        return;
      }
      API(req, res, raw);
    });

    const r = await send("GET", "/containers/json");

    expect(r.status, r.body).toBe(503);
  });

  it("relays a container list the daemon refused as it is", async () => {
    daemon.setResponder((req, res, raw) =>
      req.url.startsWith("/containers/json")
        ? respondJson(res, 400, { message: "invalid filter" })
        : API(req, res, raw),
    );

    const r = await send("GET", "/containers/json?filters=x");

    expect(r.status, r.body).toBe(400);
    expect(message(r)).toBe("invalid filter");
  });

  it("answers daemon_failed to a container list the daemon cut short", async () => {
    daemon.setResponder((req, res, raw) => {
      if (!req.url.startsWith("/containers/json")) return API(req, res, raw);
      res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      res.write("[");
      res.destroy();
    });

    const r = await send("GET", "/containers/json");

    expect(r.status, r.body).toBe(502);
  });

  it("relays an event stream the daemon refused as it is", async () => {
    daemon.setResponder((req, res, raw) =>
      req.url.startsWith("/events")
        ? respondJson(res, 400, { message: "invalid filter" })
        : API(req, res, raw),
    );

    const r = await send("GET", "/events?filters=x");

    expect(r.status, r.body).toBe(400);
    expect(message(r)).toBe("invalid filter");
  });

  it("drops every GET /events line that is not the task's", async () => {
    const own = event("container", { "cogmo.root_task": TASK_ID, name: OWN.name });
    const lines = [
      own,
      event("container", { "cogmo.root_task": SIBLING_TASK_ID, name: SIBLING.name }),
      event("container", { name: COGMO_OWN.name }),
      event("network", { container: OWN.id, name: "bridge", type: "bridge" }),
      event("volume", { driver: "local" }),
      "not json",
    ];
    daemon.setResponder((req, res, raw) => {
      if (!req.url.startsWith("/events")) return API(req, res, raw);
      res.writeHead(200, { "content-type": "application/jsonl" });
      res.end(lines.map((l) => `${l}\n`).join(""));
    });

    const r = await send("GET", "/events?since=0&filters=%7B%7D");

    expect(r.status, r.body).toBe(200);
    expect(r.body).toBe(`${own}\n`);
    expect(received()).toEqual(["GET /events?since=0&filters=%7B%7D"]);
  });
});

describe("route table", () => {
  it.each([
    ["GET", "/_ping"],
    ["HEAD", "/_ping"],
    ["GET", "/version"],
    ["GET", "/info"],
    ["GET", "/v1.44/info"],
    ["GET", "/images/json?all=1"],
    ["GET", "/images/alpine:3/json"],
    ["GET", "/images/mirror.gcr.io/pgvector/pgvector:pg18/history"],
    ["POST", "/images/create?fromImage=alpine&tag=3"],
    ["GET", "/networks"],
    ["GET", "/networks/task-net"],
    ["POST", "/networks/create"],
    ["DELETE", "/networks/task-net"],
    ["GET", "/volumes"],
    ["GET", "/volumes/v1"],
    ["POST", "/volumes/create"],
  ])("forwards %s %s", async (method, path) => {
    const r = await send(method, path);

    expect(r.status, r.body).toBe(200);
    expect(received()).toEqual([`${method} ${path}`]);
  });

  it.each([
    ["GET", "/swarm"],
    ["POST", "/swarm/init"],
    ["GET", "/nodes"],
    ["GET", "/services"],
    ["GET", "/tasks"],
    ["GET", "/secrets"],
    ["GET", "/configs"],
    ["GET", "/plugins"],
    ["POST", "/build"],
    ["POST", "/session"],
    ["POST", "/grpc"],
    ["POST", "/auth"],
    ["POST", "/commit?container=cogmo-task-own"],
    ["GET", "/system/df"],
    ["POST", "/containers/prune"],
    ["POST", "/images/prune"],
    ["POST", "/networks/prune"],
    ["POST", "/volumes/prune"],
    ["POST", "/build/prune"],
    ["POST", "/containers/cogmo-task-own/update"],
    ["POST", "/containers/own-child/update"],
    ["DELETE", "/images/alpine"],
    ["POST", "/images/alpine/tag?repo=x"],
    ["POST", "/images/alpine/push"],
    ["GET", "/images/alpine/get"],
    ["GET", "/images/get?names=alpine"],
    ["POST", "/images/load"],
    ["DELETE", "/volumes/v1"],
    ["GET", "/images/search?term=alpine"],
    ["GET", "/images/alpine/attestations"],
    ["PUT", "/volumes/v1"],
    ["GET", "/containers/cogmo-task-own/checkpoints"],
    ["GET", "/debug/pprof/heap"],
    ["OPTIONS", "/containers/json"],
    ["GET", "/foo"],
    ["GET", "/containers/cogmo-task-own/nothing"],
    ["GET", "/v1.43/containers/json"],
    ["GET", "/v1.24/_ping"],
    ["POST", "/v1.40/containers/own-child/start"],
    ["GET", "/v1.43/events"],
  ])("denies %s %s without contacting the daemon", async (method, path) => {
    await expectRejected(await send(method, path), 403, []);
  });

  it("answers 400 to a path with a malformed percent-encoding", async () => {
    await expectRejected(await send("GET", "/containers/%zz/json"), 400, []);
  });
});

describe("network connect and disconnect", () => {
  const BRIDGE_REFS = [
    ["by name", "bridge"],
    ["by id", BRIDGE_NETWORK.id],
    ["by id prefix", BRIDGE_NETWORK.id.slice(0, 12)],
  ];

  it.each(BRIDGE_REFS)(
    "forwards an owned container's connect to bridge %s with both refs rewritten",
    async (_label, ref) => {
      const r = await send(
        "POST",
        `/networks/${ref}/connect`,
        JSON.stringify({ Container: "cogmo-task-own", EndpointConfig: { Aliases: [] } }),
      );

      expect(r.status, r.body).toBe(200);
      const forwarded = expectDefined(daemon.requests().at(-1), "connect");
      expect(`${forwarded.method} ${forwarded.url}`).toBe(
        `POST /networks/${BRIDGE_NETWORK.id}/connect`,
      );
      expect(JSON.parse(forwarded.body)).toEqual({
        Container: OWN.id,
        EndpointConfig: { Aliases: [] },
      });
    },
  );

  it("forwards an owned container's disconnect from bridge with Force", async () => {
    const r = await send(
      "POST",
      "/networks/bridge/disconnect",
      JSON.stringify({ Container: OWN.id.slice(0, 12), Force: true }),
    );

    expect(r.status, r.body).toBe(200);
    const forwarded = expectDefined(daemon.requests().at(-1), "disconnect");
    expect(`${forwarded.method} ${forwarded.url}`).toBe(
      `POST /networks/${BRIDGE_NETWORK.id}/disconnect`,
    );
    expect(JSON.parse(forwarded.body)).toEqual({ Container: OWN.id, Force: true });
  });

  it("forwards the recorded testcontainers port-forwarder connect to bridge", async () => {
    daemon.setResponder(api([RECORDED_BRIDGE]));
    const req = TESTCONTAINERS_BRIDGE_CONNECT_REQUEST;

    const r = await send(req.method, req.path, req.body, { ...req.headers });

    expect(r.status, r.body).toBe(200);
    const forwarded = expectDefined(daemon.requests().at(-1), "connect");
    expect(`${forwarded.method} ${forwarded.url}`).toBe(`${req.method} ${req.path}`);
    expect(JSON.parse(forwarded.body)).toEqual(JSON.parse(req.body));
  });

  it.each([
    ["a task network", "task-net"],
    ["the host network", "host"],
    ["a missing network", "no-such-net"],
  ])("denies a connect to %s", async (_label, ref) => {
    const r = await send(
      "POST",
      `/networks/${ref}/connect`,
      JSON.stringify({ Container: "cogmo-task-own" }),
    );

    expect(r.status, r.body).toBe(403);
    expect(received().filter((line) => line.startsWith("POST"))).toEqual([]);
  });

  it("denies a disconnect from a network other than bridge", async () => {
    const r = await send(
      "POST",
      "/networks/task-net/disconnect",
      JSON.stringify({ Container: "cogmo-task-own" }),
    );

    expect(r.status, r.body).toBe(403);
    expect(received().filter((line) => line.startsWith("POST"))).toEqual([]);
  });

  it("answers unavailable when the daemon has no bridge network", async () => {
    daemon.setResponder(api([TASK_NETWORK]));

    const r = await send(
      "POST",
      "/networks/task-net/connect",
      JSON.stringify({ Container: "cogmo-task-own" }),
    );

    expect(r.status, r.body).toBe(503);
    expect(received().filter((line) => line.startsWith("POST"))).toEqual([]);
  });

  it("answers unavailable when the network resolve fails", async () => {
    daemon.setResponder((req, res, raw) =>
      req.method === "GET" && req.url.startsWith("/networks/")
        ? respondJson(res, 500, { message: "boom" })
        : API(req, res, raw),
    );

    const r = await send(
      "POST",
      "/networks/bridge/connect",
      JSON.stringify({ Container: "cogmo-task-own" }),
    );

    expect(r.status, r.body).toBe(503);
    expect(received().filter((line) => line.startsWith("POST"))).toEqual([]);
  });

  it("answers 400 to a connect body without a Container", async () => {
    const r = await send("POST", "/networks/bridge/connect", JSON.stringify({}));

    await expectRejected(r, 400, []);
  });

  it.each([
    ["connect", SIBLING.name],
    ["disconnect", SIBLING.id],
    ["connect", UNKNOWN_ID],
  ])("answers 404 to a bridge %s of a container the task does not own", async (op, ref) => {
    const r = await send("POST", `/networks/bridge/${op}`, JSON.stringify({ Container: ref }));

    expect(r.status, r.body).toBe(404);
    expect(message(r)).toBe(`No such container: ${ref}`);
    expect(received().filter((line) => line.startsWith("POST"))).toEqual([]);
  });

  it.each([
    ["EndpointConfig.IPAMConfig", { IPAMConfig: { IPv4Address: "172.17.0.99" } }],
    ["EndpointConfig.Links", { Links: [`${SIBLING.name}:db`] }],
  ])("denies a connect body that sets %s", async (_label, endpoint) => {
    const r = await send(
      "POST",
      "/networks/bridge/connect",
      JSON.stringify({ Container: "cogmo-task-own", EndpointConfig: endpoint }),
    );

    expect(r.status, r.body).toBe(403);
    expect(received().filter((line) => line.startsWith("POST"))).toEqual([]);
  });
});

describe("hop-by-hop headers", () => {
  it("drops them from a normal forward, a Trailer on a body-less GET included", async () => {
    const reply = await rawExchange(
      [
        "GET /_ping HTTP/1.1",
        "Host: docker",
        "Keep-Alive: timeout=5",
        "TE: trailers",
        "Trailer: Expires",
        "Upgrade: h2c",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );

    expect(reply).toMatch(/^HTTP\/1\.1 200 /);
    const seen = expectDefined(daemon.requests()[0], "ping").headers;
    expect(seen["keep-alive"]).toBeUndefined();
    expect(seen.te).toBeUndefined();
    expect(seen.trailer).toBeUndefined();
    expect(seen.upgrade).toBeUndefined();
  });

  it("re-frames a chunked body so none of it reaches the daemon as a request", async () => {
    const smuggled = "GET /containers/json HTTP/1.1\r\nHost: docker\r\n\r\n";
    await rawExchange(
      [
        "GET /containers/own-child/json HTTP/1.1",
        "Host: docker",
        "Transfer-Encoding: chunked",
        "Connection: close",
        "",
        `${Buffer.byteLength(smuggled).toString(16)}\r\n${smuggled}`,
        "0",
        "",
        "",
      ].join("\r\n"),
    );

    expect(received()).toEqual([resolveOf("own-child"), `GET /containers/${CHILD.id}/json`]);
    expect(expectDefined(daemon.requests()[1], "inspect").body).toBe(smuggled);
  });
});

function event(type: string, attributes: Record<string, string>): string {
  return JSON.stringify({
    Type: type,
    Action: "start",
    Actor: { ID: OWN.id, Attributes: attributes },
    scope: "local",
    time: 1,
  });
}

/** Write `request` on a fresh connection and collect everything until the proxy closes it. */
function rawExchange(request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socket });
    const chunks: Buffer[] = [];
    client.on("data", (c: Buffer) => chunks.push(c));
    client.on("error", reject);
    client.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    client.once("connect", () => client.write(request));
  });
}
