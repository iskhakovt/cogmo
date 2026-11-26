/**
 * A `CogmoSocketProxy` in front of the shared fake daemon, for the proxy's
 * route, ownership and network tests. The daemon knows the task's own
 * container, a child of it, a salvage container that shares the task's
 * `root_task_id` at depth 0, a sibling task's container and one of Cogmo's
 * own; the fake `ContainerRows` returns the rows each task's store read
 * would.
 *
 * `useProxyHarness()` registers the `beforeEach` and `afterEach` that start
 * and stop it, so a test file calls it once at the top level.
 */

import { mkdtemp, rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { okAsync } from "neverthrow";
import { afterEach, beforeEach, expect } from "vitest";
import { type MockProxy, mock } from "vitest-mock-extended";
import { z } from "zod";
import { CogmoSocketProxy } from "../sandbox/proxy/index.js";
import type { ContainerRows, TaskContainerRow, TaskScope } from "../sandbox/proxy/types.js";
import { expectDefined } from "./assertions.js";
import {
  BRIDGE_NETWORK,
  dockerApi,
  type FakeContainer,
  type FakeDaemonResponder,
  type FakeDockerDaemon,
  type FakeNetwork,
  requestOverSocket,
  type SocketResponse,
  startFakeDockerDaemon,
} from "./fake-docker-daemon.js";

export const TASK_ID = "019d0000-0000-7000-8000-00000000aaaa";
export const SIBLING_TASK_ID = "019d0000-0000-7000-8000-00000000cccc";

/** A full container or network id that starts with `lead`. */
export function containerId(lead: string): string {
  return `${lead}${"0".repeat(64 - lead.length)}`;
}

/** The task's depth-0 container. */
export const OWN: FakeContainer = {
  id: containerId("1a"),
  name: "cogmo-task-own",
  labels: { "cogmo.root_task": TASK_ID, "cogmo.parent": "" },
};
/** A child with a row under the task's own, as the task's children carry from slice 3 on. */
export const CHILD: FakeContainer = {
  id: containerId("2b"),
  name: "own-child",
  labels: { "cogmo.root_task": TASK_ID, "cogmo.parent": OWN.id },
};
export const SIBLING: FakeContainer = {
  id: containerId("3c"),
  name: "cogmo-task-sibling",
  labels: { "cogmo.root_task": SIBLING_TASK_ID, "cogmo.parent": "" },
};
/** A container Cogmo runs for itself, such as a skills worker. */
export const COGMO_OWN: FakeContainer = {
  id: containerId("4d"),
  name: "cogmo-skills-worker",
  labels: { "cogmo.managed": "true" },
};
/** The container the recorded testcontainers requests name, a child of the task's own. */
export const RECORDED: FakeContainer = {
  id: "477cdbd59ea8e4d2fe700c1a771344e7ee9162a6ad10ccbee9f81ddc7b1fe880",
  name: "capture-alpine",
  labels: { "cogmo.root_task": TASK_ID, "cogmo.parent": OWN.id },
};
/** Coding teardown's salvage container: the task's `root_task_id`, at depth 0, not the task's. */
export const SALVAGE: FakeContainer = {
  id: containerId("7a"),
  name: "cogmo-salvage",
  labels: { "cogmo.root_task": TASK_ID, "cogmo.parent": "" },
};
export const UNKNOWN_ID = containerId("9f");

export const RECORDED_BRIDGE: FakeNetwork = {
  id: "8410490959e2f636b23cdb92ee4452b0e991c0ac62ff8f4011291227641c721c",
  name: "bridge",
};
export const TASK_NETWORK: FakeNetwork = { id: containerId("5e"), name: "task-net" };
export const HOST_NETWORK: FakeNetwork = { id: containerId("6f"), name: "host" };

const OWN_ROW: TaskContainerRow = {
  id: "019d0000-0000-7000-8000-00000000bbbb",
  dockerId: OWN.id,
  parentId: null,
};
const SIBLING_ROW: TaskContainerRow = {
  id: "019d0000-0000-7000-8000-00000000dddd",
  dockerId: SIBLING.id,
  parentId: null,
};
export const SALVAGE_ROW: TaskContainerRow = {
  id: "019d0000-0000-7000-8000-00000000eeee",
  dockerId: SALVAGE.id,
  parentId: null,
};
export const CHILD_ROW: TaskContainerRow = {
  id: "019d0000-0000-7000-8000-00000000c001",
  dockerId: CHILD.id,
  parentId: OWN_ROW.id,
};
const RECORDED_ROW: TaskContainerRow = {
  id: "019d0000-0000-7000-8000-00000000c002",
  dockerId: RECORDED.id,
  parentId: OWN_ROW.id,
};

/** The task's rows that are not `reaped`, as its store read returns them. */
export const TASK_ROWS: ReadonlyArray<TaskContainerRow> = [
  OWN_ROW,
  CHILD_ROW,
  RECORDED_ROW,
  SALVAGE_ROW,
];

export const SCOPE: TaskScope = {
  taskId: TASK_ID,
  parentContainerRowId: OWN_ROW.id,
  parentDockerId: OWN.id,
  parentDepth: 0,
  runtime: "sysbox-runc",
  cgroupParent: "cogmo-task-abc.slice",
  instanceId: "019d0000-0000-7000-8000-0000000000ff",
  resourceLimits: { cpus: 2, memory_bytes: 1024 ** 3, pids: 256 },
};

export const SIBLING_SCOPE: TaskScope = {
  ...SCOPE,
  taskId: SIBLING_TASK_ID,
  parentContainerRowId: SIBLING_ROW.id,
  parentDockerId: SIBLING.id,
};

const ErrorSchema = z.object({ message: z.string() });

/** The fake daemon with these containers and `networks`. */
export function api(networks: ReadonlyArray<FakeNetwork>): FakeDaemonResponder {
  return dockerApi({
    images: new Map([["alpine:3", { id: `sha256:${"a".repeat(64)}`, env: [] }]]),
    containers: [OWN, CHILD, SIBLING, COGMO_OWN, RECORDED, SALVAGE],
    networks,
    arch: "amd64",
    bridgeGateway: "172.17.0.1",
    rootless: false,
  });
}

export const API = api([BRIDGE_NETWORK, TASK_NETWORK, HOST_NETWORK]);

export interface ProxyHarness {
  readonly daemon: FakeDockerDaemon;
  readonly proxy: CogmoSocketProxy;
  /** Returns `TASK_ROWS` for the task and the sibling's one row for the sibling. */
  readonly rows: MockProxy<ContainerRows>;
  /** The task's socket. */
  readonly socket: string;
  send(
    method: string,
    path: string,
    body?: string,
    headers?: Record<string, string>,
  ): Promise<SocketResponse>;
  /** Every request the daemon received, as `METHOD url`. */
  received(): string[];
  /** Assert the status, and that the daemon received exactly `reached`. */
  expectRejected(r: SocketResponse, status: number, reached: ReadonlyArray<string>): void;
  /** Write `request` on a fresh connection to the task's socket and collect everything until it closes. */
  rawExchange(request: string): Promise<string>;
  /**
   * Write an upgrade `request`, end the client's side at once, and collect
   * everything, as latin1, until the connection closes: the daemon ends a
   * switched stream once the client has ended its side.
   */
  upgradeExchange(request: string | Buffer): Promise<string>;
}

interface Running {
  baseDir: string;
  daemon: FakeDockerDaemon;
  proxy: CogmoSocketProxy;
  rows: MockProxy<ContainerRows>;
  socket: string;
}

export function useProxyHarness(): ProxyHarness {
  let running: Running | undefined;
  const current = (): Running => expectDefined(running, "the proxy harness");

  beforeEach(async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "cogmo-proxy-harness-"));
    const daemon = await startFakeDockerDaemon(join(baseDir, "docker.sock"), API);
    const rows = mock<ContainerRows>();
    rows.forTask.mockImplementation((taskId) =>
      okAsync(taskId === TASK_ID ? TASK_ROWS : [SIBLING_ROW]),
    );
    const proxy = await CogmoSocketProxy.create({
      socketDir: join(baseDir, "sockets"),
      hostDockerSocket: daemon.socketPath,
      containerRows: rows,
    });
    const socket = await proxy.registerTask(SCOPE);
    running = { baseDir, daemon, proxy, rows, socket };
  });

  afterEach(async () => {
    const { baseDir, daemon, proxy } = current();
    running = undefined;
    await proxy.close();
    await daemon.close();
    await rm(baseDir, { recursive: true, force: true });
  });

  const received = () =>
    current()
      .daemon.requests()
      .map((r) => `${r.method} ${r.url}`);

  return {
    get daemon() {
      return current().daemon;
    },
    get proxy() {
      return current().proxy;
    },
    get rows() {
      return current().rows;
    },
    get socket() {
      return current().socket;
    },
    send: (method, path, body, headers) =>
      requestOverSocket(current().socket, {
        method,
        path,
        ...(body !== undefined && { body }),
        ...(headers !== undefined && { headers }),
      }),
    received,
    expectRejected: (r, status, reached) => {
      expect(r.status, r.body).toBe(status);
      expect(received()).toEqual(reached);
    },
    rawExchange: (request) => rawExchange(current().socket, request),
    upgradeExchange: (request) => upgradeExchange(current().socket, request),
  };
}

/** The resolve lookup the proxy makes for a container ref. */
export function resolveOf(ref: string): string {
  return `GET /containers/${ref}/json`;
}

/** A rejection's message. */
export function message(r: SocketResponse): string {
  return ErrorSchema.parse(JSON.parse(r.body)).message;
}

/** A request preamble asking to upgrade to a raw stream, with no body. */
export function upgradeRequest(method: string, path: string): string {
  return [
    `${method} ${path} HTTP/1.1`,
    "Host: docker",
    "Connection: Upgrade",
    "Upgrade: tcp",
    "Content-Length: 0",
    "",
    "",
  ].join("\r\n");
}

/** `count` filler header lines, each `a: 1`, joined for a hand-built request. */
export function fillerHeaders(count: number): string {
  return Array.from({ length: count }, () => "a: 1").join("\r\n");
}

function upgradeExchange(socketPath: string, request: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath, allowHalfOpen: true });
    const chunks: Buffer[] = [];
    client.on("data", (c: Buffer) => chunks.push(c));
    client.on("error", reject);
    client.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    client.once("connect", () => client.end(request));
  });
}

function rawExchange(socketPath: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    client.on("data", (c: Buffer) => chunks.push(c));
    client.on("error", reject);
    client.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    client.once("connect", () => client.write(request));
  });
}
