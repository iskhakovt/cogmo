import { mkdtemp, rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { expectDefined } from "../../test/assertions.js";
import { DOCKER_CLI_EXEC_REQUEST } from "../../test/docker-cli-exec-request.js";
import {
  dockerApi,
  type FakeDockerDaemon,
  requestOverSocket,
  type SocketResponse,
  startFakeDockerDaemon,
} from "../../test/fake-docker-daemon.js";
import { CogmoSocketProxy } from "./index.js";
import type { TaskScope } from "./types.js";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../logger.js", () => ({ logger: { child: () => log } }));

const SCOPE: TaskScope = {
  taskId: "019d0000-0000-7000-8000-00000000aaaa",
  parentContainerRowId: "019d0000-0000-7000-8000-00000000bbbb",
  parentDockerId: "docker-parent-abc",
  parentDepth: 0,
  runtime: "sysbox-runc",
  cgroupParent: "cogmo-task-abc.slice",
  instanceId: "019d0000-0000-7000-8000-0000000000ff",
  resourceLimits: { cpus: 2, memory_bytes: 1024 ** 3, pids: 256 },
};

const ErrorSchema = z.object({ message: z.string() });

let baseDir: string;
let daemon: FakeDockerDaemon;
let proxy: CogmoSocketProxy;
let socket: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "cogmo-proxy-exec-"));
  daemon = await startFakeDockerDaemon(
    join(baseDir, "docker.sock"),
    dockerApi({ images: new Map(), arch: "amd64", bridgeGateway: "172.17.0.1", rootless: false }),
  );
  proxy = await CogmoSocketProxy.create({
    socketDir: join(baseDir, "sockets"),
    hostDockerSocket: daemon.socketPath,
  });
  socket = await proxy.registerTask(SCOPE);
});

afterEach(async () => {
  await proxy.close();
  await daemon.close();
  await rm(baseDir, { recursive: true, force: true });
});

function exec(body: unknown, path: string): Promise<SocketResponse> {
  return execRaw(JSON.stringify(body), path);
}

function execRaw(body: string, path: string): Promise<SocketResponse> {
  return requestOverSocket(socket, { method: "POST", path, body });
}

function forwardedBody(): unknown {
  const [only, ...rest] = daemon.requests();
  expect(rest).toEqual([]);
  return JSON.parse(expectDefined(only, "forwarded exec").body);
}

async function expectRejected(r: SocketResponse, status: number): Promise<void> {
  expect(r.status, r.body).toBe(status);
  expect(daemon.requests()).toEqual([]);
}

function message(r: SocketResponse): string {
  return ErrorSchema.parse(JSON.parse(r.body)).message;
}

describe("exec policy", () => {
  it("forwards every allowed field as sent", async () => {
    const body = {
      Cmd: ["sh", "-c", "true"],
      Env: ["A=1"],
      WorkingDir: "/workspace",
      User: "1000",
      Tty: false,
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      DetachKeys: "ctrl-p,ctrl-q",
      ConsoleSize: [24, 80],
      Detach: true,
    };
    const r = await exec(body, "/containers/abc/exec");

    expect(r.status, r.body).toBe(201);
    expect(forwardedBody()).toEqual(body);
    expect(expectDefined(daemon.requests()[0], "exec").url).toBe("/containers/abc/exec");
  });

  it.each([
    ["Privileged", true, false],
    ["FutureField", "x", ""],
  ])("denies %s when non-zero and drops it when zero", async (field, nonZero, zero) => {
    const denied = await exec({ Cmd: ["id"], [field]: nonZero }, "/containers/abc/exec");
    await expectRejected(denied, 403);
    expect(message(denied)).toContain(field);

    const passed = await exec({ Cmd: ["id"], [field]: zero }, "/containers/abc/exec");
    expect(passed.status, passed.body).toBe(201);
    expect(forwardedBody()).toEqual({ Cmd: ["id"] });
  });

  it("passes the recorded Docker CLI exec create, its zero Privileged dropped", async () => {
    const req = DOCKER_CLI_EXEC_REQUEST;
    const r = await requestOverSocket(socket, {
      method: req.method,
      path: req.path,
      body: req.body,
      headers: { ...req.headers },
    });

    expect(r.status, r.body).toBe(201);
    expect(expectDefined(daemon.requests()[0], "exec").url).toBe("/v1.51/containers/c1/exec");
    expect(forwardedBody()).toEqual({
      User: "",
      Tty: false,
      AttachStdin: false,
      AttachStderr: true,
      AttachStdout: true,
      DetachKeys: "",
      Env: null,
      WorkingDir: "",
      Cmd: ["id"],
    });
  });

  it("rejects an integer outside the safe range", async () => {
    const r = await execRaw(
      '{"Cmd":["id"],"ConsoleSize":[24,9007199254740993]}',
      "/containers/abc/exec",
    );

    await expectRejected(r, 400);
  });

  it("names a refused SYSBOX_ variable without its value", async () => {
    const r = await exec({ Cmd: ["id"], Env: ["SYSBOX_FOO=s3cret-value"] }, "/containers/abc/exec");

    await expectRejected(r, 403);
    expect(message(r)).toContain("SYSBOX_FOO");
    expect(r.body).not.toContain("s3cret-value");
  });

  it("logs a rejected request's path without its query", async () => {
    const r = await exec(
      { Cmd: ["id"], Privileged: true },
      "/containers/abc/exec?Env=TOKEN%3Ds3cret",
    );

    await expectRejected(r, 403);
    const logged = JSON.stringify(log.info.mock.calls);
    expect(logged).toContain('"path":"/containers/abc/exec"');
    expect(logged).not.toContain("s3cret");
  });

  it.each([
    ["privileged", { cmd: ["id"], privileged: true }],
    ["PRIVILEGED", { Cmd: ["id"], PRIVILEGED: true }],
  ])("reads the case variant %s", async (_label, body) => {
    await expectRejected(await exec(body, "/containers/abc/exec"), 403);
  });

  it("denies a privileged exec on a container name with a slash, as the daemon routes it", async () => {
    // The daemon routes `/containers/{name:.*}/exec`; a legacy link names a
    // container `/parent/alias`.
    const r = await exec({ Cmd: ["sh"], Privileged: true }, "/containers/parent/alias/exec");

    await expectRejected(r, 403);
  });

  it("forwards a case variant under its canonical name", async () => {
    const r = await exec({ cmd: ["id"], workingdir: "/" }, "/containers/abc/exec");

    expect(r.status, r.body).toBe(201);
    expect(forwardedBody()).toEqual({ Cmd: ["id"], WorkingDir: "/" });
  });

  it.each(["SYSBOX_IGNORE_SYSFS=1", "sysbox_x=1"])("denies the env entry %s", async (entry) => {
    const r = await exec({ Cmd: ["id"], Env: [entry] }, "/containers/abc/exec");

    await expectRejected(r, 403);
    expect(message(r)).toContain("SYSBOX_");
  });

  it.each([
    ["no Cmd", '{"Env":["A=1"]}'],
    ["an empty Cmd", '{"Cmd":[]}'],
    ["a string Cmd", '{"Cmd":"id"}'],
    ["keys that differ only in case", '{"Cmd":["id"],"cmd":["sh"]}'],
    ["a non-ASCII key", '{"Cmd":["id"],"Usér":"root"}'],
    ["a __proto__ key", '{"Cmd":["id"],"__proto__":{"Privileged":true}}'],
    ["an array body", "[]"],
    ["invalid JSON", "{"],
  ])("%s is malformed", async (_label, raw) => {
    await expectRejected(await execRaw(raw, "/containers/abc/exec"), 400);
  });

  it("rejects a body over 1 MiB", async () => {
    const r = await exec({ Cmd: ["x".repeat(2 * 1024 * 1024)] }, "/containers/abc/exec");

    await expectRejected(r, 413);
  });

  it.each(["/v1.43", "/v1.12"])("denies an exec create under %s", async (prefix) => {
    const r = await exec({ Cmd: ["id"] }, `${prefix}/containers/abc/exec`);

    await expectRejected(r, 403);
    expect(message(r)).toContain("1.44");
  });

  it("forwards an exec create under v1.44", async () => {
    const r = await exec({ Cmd: ["id"] }, "/v1.44/containers/abc/exec");

    expect(r.status, r.body).toBe(201);
    expect(expectDefined(daemon.requests()[0], "exec").url).toBe("/v1.44/containers/abc/exec");
  });
});

describe("exec policy: a client that hangs up mid-body", () => {
  it("is an expected rejection, not a fault", async () => {
    const client = net.createConnection({ path: socket });
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write(
      "POST /containers/abc/exec HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n" +
        'Content-Length: 100\r\n\r\n{"Cmd":',
    );
    client.destroy();

    await vi.waitFor(() =>
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ rejection: expect.objectContaining({ kind: "malformed" }) }),
        "proxy request rejected",
      ),
    );
    expect(log.error).not.toHaveBeenCalled();
    expect(daemon.requests()).toEqual([]);
  });
});
