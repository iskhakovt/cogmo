import { mkdtemp, rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectDefined } from "../../test/assertions.js";
import { type TaskSocket, TaskSockets } from "./task-sockets.js";
import type { TaskScope } from "./types.js";

const SCOPE: TaskScope = {
  taskId: "019d0000-0000-7000-8000-00000000aaaa",
  anchor: null,
  parentDepth: 0,
  runtime: "runc",
  cgroupParent: "cogmo-task-abc.slice",
  instanceId: "019d0000-0000-7000-8000-0000000000ff",
  resourceLimits: { cpus: 1, memory_bytes: 1024 ** 3, pids: 64 },
  ttlExpiresAt: new Date("2026-12-01T00:00:00.000Z"),
};

let dir: string;
let sockets: TaskSockets;
/** The task socket each accepted connection was handed with, in order. */
let accepted: TaskSocket[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cogmo-task-sockets-"));
  accepted = [];
  sockets = new TaskSockets({
    socketDir: dir,
    onConnection: (socket, task) => {
      accepted.push(task);
      socket.destroy();
    },
  });
});

afterEach(async () => {
  await sockets.closeAll();
  await rm(dir, { recursive: true, force: true });
});

/** Connect to `path` and resolve once the socket has handed the connection on. */
async function connect(path: string): Promise<TaskSocket> {
  const before = accepted.length;
  const client = net.createConnection({ path });
  client.on("error", () => {});
  await new Promise<void>((resolve) => client.once("close", () => resolve()));
  return expectDefined(accepted[before], "the accepted connection's task socket");
}

describe("TaskSockets", () => {
  it("binds each registration on a path of its own, which an upsert keeps", async () => {
    const first = await sockets.register(SCOPE);
    const upserted = await sockets.register({ ...SCOPE, anchor: { rowId: "r", dockerId: "d" } });
    await sockets.unregister(SCOPE.taskId);
    const again = await sockets.register(SCOPE);

    expect(basename(first)).toBe(`${SCOPE.taskId}-1.sock`);
    expect(upserted).toBe(first);
    expect(basename(again)).toBe(`${SCOPE.taskId}-2.sock`);
  });

  it("hands each connection the socket serving the latest scope, and retiring once torn down", async () => {
    const path = await sockets.register(SCOPE);
    await sockets.register({ ...SCOPE, anchor: { rowId: "r", dockerId: "d" } });
    const task = await connect(path);

    expect(task.state).toEqual({
      kind: "serving",
      scope: { ...SCOPE, anchor: { rowId: "r", dockerId: "d" } },
    });
    await sockets.unregister(SCOPE.taskId);
    expect(task.state).toEqual({ kind: "retiring" });
    expect(task.signal.aborted).toBe(true);
  });

  it("keeps a new registration's socket file when the old one's listener closes after it bound", async () => {
    const old = await sockets.register(SCOPE);
    const tearingDown = sockets.unregister(SCOPE.taskId);
    const again = await sockets.register(SCOPE);
    await tearingDown;

    expect(again).not.toBe(old);
    const task = await connect(again);
    expect(task.socketPath).toBe(again);
  });

  it("lets an unregister during closeAll join its teardown", async () => {
    await sockets.register(SCOPE);
    const closing = sockets.closeAll();
    let joined = false;
    void sockets.unregister(SCOPE.taskId).then(() => {
      joined = true;
    });

    await Promise.resolve();
    expect(joined).toBe(false);
    await closing;
    expect(joined).toBe(true);
  });

  it("refuses a registration once closed", async () => {
    await sockets.closeAll();

    await expect(sockets.register(SCOPE)).rejects.toThrow("proxy is closed");
  });
});
