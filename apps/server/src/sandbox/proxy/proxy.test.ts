import { mkdir, mkdtemp, rm, rmdir } from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ok, okAsync, ResultAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MockProxy, mock } from "vitest-mock-extended";
import { z } from "zod";
import { expectDefined, resolvesWithin } from "../../test/assertions.js";
import { CogmoSocketProxy } from "./index.js";
import type { ChildContainers, ContainerRows, TaskScope } from "./types.js";

// Subset of the Docker /containers/create body schema covering the fields
// these tests assert on. `passthrough()` keeps all upstream fields visible
// without requiring the test to enumerate them.
const ContainerCreateBodySchema = z
  .object({
    Image: z.string().optional(),
    HostConfig: z
      .object({
        Runtime: z.string().optional(),
        CgroupParent: z.string().optional(),
      })
      .passthrough()
      .optional(),
    Labels: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const ErrorBodySchema = z.object({ message: z.string() }).passthrough();

/** Budget for each wait on a connection; ample headroom over the milliseconds they take. */
const SETTLE_MS = 2_500;
/** Covers the four sequential waits of `expectUnregisterEnds`. */
const STREAM_TEST_TIMEOUT_MS = 4 * SETTLE_MS + 1_000;

function parseContainerCreate(body: string): z.infer<typeof ContainerCreateBodySchema> {
  return ContainerCreateBodySchema.parse(JSON.parse(body));
}

function parseError(body: string): z.infer<typeof ErrorBodySchema> {
  return ErrorBodySchema.parse(JSON.parse(body));
}

/** The container creates that reached the daemon, without the image inspects before them. */
function upstreamCreates(): typeof upstreamRequests {
  return upstreamRequests.filter((r) => r.url.startsWith("/containers/create"));
}

let baseDir: string;
let upstreamSocketPath: string;
let upstream: http.Server;
let upstreamRequests: Array<{
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}> = [];
let upstreamResponder: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let proxy: CogmoSocketProxy;
let childContainers: MockProxy<ChildContainers>;

const SCOPE: TaskScope = {
  taskId: "019d0000-0000-7000-8000-00000000aaaa",
  anchor: { rowId: "019d0000-0000-7000-8000-00000000bbbb", dockerId: "docker-parent-abc" },
  parentDepth: 0,
  runtime: "sysbox-runc",
  cgroupParent: "cogmo-task-abc.slice",
  instanceId: "019d0000-0000-7000-8000-0000000000ff",
  resourceLimits: { cpus: 1, memory_bytes: 1024 ** 3, pids: 128 },
  ttlExpiresAt: new Date("2026-12-01T00:00:00.000Z"),
};

/** What the daemon answers every image inspect with; a create forwards its id. */
const IMAGE_ID = `sha256:${"a".repeat(64)}`;

/** What the daemon resolves every container ref to: the task's own container. */
const TASK_CONTAINER_ID = "d".repeat(64);

/** The id the daemon answers a container create with. */
const CHILD_CONTAINER_ID = "c".repeat(64);

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "cogmo-proxy-test-"));
  upstreamSocketPath = join(baseDir, "docker.sock");
  upstreamRequests = [];
  upstreamResponder = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}\n');
  };
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      upstreamRequests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.method === "GET" && /^\/images\/.+\/json$/.test(req.url ?? "")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ Id: IMAGE_ID, Config: { Env: [] } }));
        return;
      }
      if (req.method === "GET" && /^\/containers\/[^/]+\/json$/.test(req.url ?? "")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ Id: TASK_CONTAINER_ID }));
        return;
      }
      upstreamResponder(req, res);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(upstreamSocketPath, resolve));

  const containerRows = mock<ContainerRows>();
  containerRows.forTask.mockReturnValue(
    okAsync([
      {
        id: expectDefined(SCOPE.anchor, "the scope's anchor").rowId,
        dockerId: TASK_CONTAINER_ID,
        parentId: null,
        status: "running",
      },
    ]),
  );
  childContainers = mock<ChildContainers>();
  childContainers.record.mockReturnValue(okAsync(undefined));
  proxy = await CogmoSocketProxy.create({
    socketDir: join(baseDir, "sockets"),
    hostDockerSocket: upstreamSocketPath,
    containerRows,
    childContainers,
  });
});

afterEach(async () => {
  await proxy.close();
  upstream.closeAllConnections?.();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(baseDir, { recursive: true, force: true });
});

/** HTTP/1.1 request to a Unix socket. Returns status + body. */
function unixRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: string | Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path,
        // Disable keep-alive on the test client so afterEach() doesn't
        // wait 4s for the keepalive timeout before upstream.close()
        // returns.
        agent: new http.Agent({ keepAlive: false }),
        headers: {
          "content-type": "application/json",
          connection: "close",
          ...headers,
          ...(body != null ? { "content-length": String(Buffer.byteLength(body)) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

describe("CogmoSocketProxy", () => {
  it("registerTask creates a working socket; pass-through forwards GET /version", async () => {
    upstreamResponder = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"Version":"24.0.0"}');
    };
    const sock = await proxy.registerTask(SCOPE);
    const r = await unixRequest(sock, "GET", "/version");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ Version: "24.0.0" });
    expect(upstreamRequests).toHaveLength(1);
    const versionReq = expectDefined(upstreamRequests[0], "/version request");
    expect(versionReq.method).toBe("GET");
    expect(versionReq.url).toBe("/version");
  });

  it("denies /swarm/* with 403 without contacting upstream", async () => {
    const sock = await proxy.registerTask(SCOPE);
    const r = await unixRequest(sock, "GET", "/swarm/inspect");
    expect(r.status).toBe(403);
    expect(parseError(r.body).message).toContain("swarm");
    expect(upstreamRequests).toHaveLength(0);
  });

  it.each(["/plugins", "/nodes/abc"])("denies %s", async (path) => {
    const sock = await proxy.registerTask(SCOPE);
    const r = await unixRequest(sock, "GET", path);
    expect(r.status).toBe(403);
    expect(upstreamRequests).toHaveLength(0);
  });

  it("rejects POST /containers/create with HostConfig.Privileged=true and never contacts upstream", async () => {
    const sock = await proxy.registerTask(SCOPE);
    const r = await unixRequest(
      sock,
      "POST",
      "/containers/create",
      JSON.stringify({ Image: "alpine", HostConfig: { Privileged: true } }),
    );
    expect(r.status).toBe(403);
    expect(parseError(r.body).message).toContain("Privileged");
    expect(upstreamRequests).toHaveLength(0);
  });

  it("forwards POST /containers/create with a rebuilt body — labels, runtime and cgroup parent injected", async () => {
    upstreamResponder = (_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ Id: CHILD_CONTAINER_ID, Warnings: [] }));
    };
    const sock = await proxy.registerTask(SCOPE);
    const r = await unixRequest(
      sock,
      "POST",
      "/containers/create",
      JSON.stringify({ Image: "alpine", Labels: { "user.foo": "bar" } }),
    );
    expect(r.status).toBe(201);

    expect(upstreamCreates()).toHaveLength(1);
    const createReq = expectDefined(upstreamCreates()[0], "containers/create request");
    const seen = parseContainerCreate(createReq.body);
    expect(seen.Image).toBe(IMAGE_ID);
    expect(seen.HostConfig?.Runtime).toBe("sysbox-runc");
    expect(seen.HostConfig?.CgroupParent).toBe("cogmo-task-abc.slice");
    expect(seen.Labels?.["user.foo"]).toBe("bar");
    expect(seen.Labels?.["cogmo.managed"]).toBe("true");
    expect(seen.Labels?.["cogmo.parent"]).toBe("docker-parent-abc");
    expect(seen.Labels?.["cogmo.depth"]).toBe("1");
    // Re-supplied content-length matches the rebuilt body length.
    expect(createReq.headers["content-length"]).toBe(String(Buffer.byteLength(createReq.body)));
  });

  it("propagates upstream errors as 502 when upstream socket isn't writable", async () => {
    // Close upstream immediately to make connections fail.
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    const sock = await proxy.registerTask(SCOPE);
    const r = await unixRequest(sock, "GET", "/version");
    expect(r.status).toBe(502);
  });

  it("isolates task scopes — two registered tasks each get their own socket", async () => {
    upstreamResponder = (_req, res) => {
      res.writeHead(201);
      res.end(JSON.stringify({ Id: CHILD_CONTAINER_ID }));
    };
    const taskA: TaskScope = { ...SCOPE, taskId: "019d0000-0000-7000-8000-0000000000a1" };
    const taskB: TaskScope = {
      ...SCOPE,
      taskId: "019d0000-0000-7000-8000-0000000000b2",
      anchor: {
        rowId: "019d0000-0000-7000-8000-00000000bbbb",
        dockerId: "docker-parent-different",
      },
      cgroupParent: "cogmo-task-b.slice",
    };
    const sockA = await proxy.registerTask(taskA);
    const sockB = await proxy.registerTask(taskB);

    await unixRequest(sockA, "POST", "/containers/create", JSON.stringify({ Image: "alpine" }));
    await unixRequest(sockB, "POST", "/containers/create", JSON.stringify({ Image: "alpine" }));

    expect(upstreamCreates()).toHaveLength(2);
    const seenA = parseContainerCreate(expectDefined(upstreamCreates()[0], "task A request").body);
    const seenB = parseContainerCreate(expectDefined(upstreamCreates()[1], "task B request").body);
    expect(seenA.HostConfig?.CgroupParent).toBe("cogmo-task-abc.slice");
    expect(seenA.Labels?.["cogmo.root_task"]).toBe(taskA.taskId);
    expect(seenB.HostConfig?.CgroupParent).toBe("cogmo-task-b.slice");
    expect(seenB.Labels?.["cogmo.root_task"]).toBe(taskB.taskId);
    expect(seenB.Labels?.["cogmo.parent"]).toBe("docker-parent-different");
  });

  it("unregisterTask removes the socket file", async () => {
    const sock = await proxy.registerTask(SCOPE);
    expect(await socketExists(sock)).toBe(true);
    await proxy.unregisterTask(SCOPE.taskId);
    expect(await socketExists(sock)).toBe(false);
  });

  it("re-registering the same taskId is idempotent (re-binds the socket)", async () => {
    const sock1 = await proxy.registerTask(SCOPE);
    const sock2 = await proxy.registerTask(SCOPE);
    expect(sock1).toBe(sock2);
    // Still reachable.
    upstreamResponder = (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    };
    const r = await unixRequest(sock2, "GET", "/_ping");
    expect(r.status).toBe(200);
  });

  it("rejects requests via a non-task-scope connection (defense in depth)", async () => {
    // We exercise this by calling the http server directly without the
    // per-task scope wrapper. Simulate by connecting raw and sending
    // a request — but since registerTask is the only public entry, this
    // is more of a property test: any connection that reaches the http
    // server must have a scope, and connections to unregistered sockets
    // fail at the OS level (ENOENT).
    const fake = join(baseDir, "sockets", "no-such-task.sock");
    const client = net.createConnection({ path: fake });
    const err = await new Promise<Error>((resolve) => client.once("error", resolve));
    expect(err.message).toMatch(/ENOENT|connect/);
  });

  it("unregisterTask ends a followed log stream instead of waiting on it", {
    timeout: STREAM_TEST_TIMEOUT_MS,
  }, async () => {
    const daemon = holdUpstreamOpen();
    const sock = await proxy.registerTask(SCOPE);
    const client = openStream(
      sock,
      "GET /containers/abc/logs?follow=1 HTTP/1.1\r\nHost: docker\r\n\r\n",
    );

    await expectUnregisterEnds(daemon, client);
  });

  it("unregisterTask ends an event stream instead of waiting on it", {
    timeout: STREAM_TEST_TIMEOUT_MS,
  }, async () => {
    const daemon = holdUpstreamOpen();
    const sock = await proxy.registerTask(SCOPE);
    const client = openStream(sock, "GET /events HTTP/1.1\r\nHost: docker\r\n\r\n");

    await expectUnregisterEnds(daemon, client);
  });

  it("unregisterTask ends a forwarded request still waiting on the daemon", {
    timeout: STREAM_TEST_TIMEOUT_MS,
  }, async () => {
    const daemon = holdUpstreamOpen();
    const sock = await proxy.registerTask(SCOPE);
    const client = openStream(
      sock,
      "POST /containers/abc/wait HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\n\r\n",
    );

    await expectUnregisterEnds(daemon, client);
  });

  it("unregisterTask waits 30 seconds for a container create still waiting on the daemon, then ends it", {
    timeout: STREAM_TEST_TIMEOUT_MS,
  }, async () => {
    const daemon = holdUpstreamOpen();
    const sock = await proxy.registerTask(SCOPE);
    const body = JSON.stringify({ Image: "alpine" });
    const client = openStream(
      sock,
      "POST /containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    await resolvesWithin(daemon.held, SETTLE_MS, "the request to reach the daemon");
    let daemonClosed = false;
    void daemon.closed.then(() => {
      daemonClosed = true;
    });

    let unregistered = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let unregistering: Promise<void>;
    try {
      unregistering = proxy.unregisterTask(SCOPE.taskId).then(() => {
        unregistered = true;
      });
      // Real time for the I/O an unregister that did not wait would finish in.
      await sleep(200);
      await vi.advanceTimersByTimeAsync(29_900);
      expect(unregistered).toBe(false);
      expect(daemonClosed).toBe(false);

      await vi.advanceTimersByTimeAsync(100);
    } finally {
      vi.useRealTimers();
    }
    await resolvesWithin(unregistering, SETTLE_MS, "unregisterTask");
    await resolvesWithin(client.closed, SETTLE_MS, "the client connection to close");
    await resolvesWithin(daemon.closed, SETTLE_MS, "the daemon connection to close");
  });

  it("answers unavailable on an open connection while the task is torn down", {
    timeout: STREAM_TEST_TIMEOUT_MS,
  }, async () => {
    // The daemon holds the create unanswered and answers everything else.
    const held = Promise.withResolvers<void>();
    const answer = upstreamResponder;
    upstreamResponder = (req, res) => {
      if (!(req.url ?? "").startsWith("/containers/create")) return answer(req, res);
      res.writeHead(201, { "content-type": "application/json" });
      res.flushHeaders();
      held.resolve();
    };
    const sock = await proxy.registerTask(SCOPE);
    const body = JSON.stringify({ Image: "alpine" });
    openStream(
      sock,
      "POST /containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    await resolvesWithin(held.promise, SETTLE_MS, "the create to reach the daemon");
    const open = openStream(sock, "GET /_ping HTTP/1.1\r\nHost: docker\r\n\r\n");
    await vi.waitFor(() => expect(open.received()).toContain("200 OK"), { timeout: SETTLE_MS });
    const forwarded = upstreamRequests.length;

    void proxy.unregisterTask(SCOPE.taskId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    open.write("GET /_ping HTTP/1.1\r\nHost: docker\r\n\r\n");

    await vi.waitFor(() => expect(open.received()).toContain("503 Service Unavailable"), {
      timeout: SETTLE_MS,
    });
    expect(upstreamRequests).toHaveLength(forwarded);
  });

  it("close() ends a teardown still waiting for a create at once", {
    timeout: STREAM_TEST_TIMEOUT_MS,
  }, async () => {
    const daemon = holdUpstreamOpen();
    const sock = await proxy.registerTask(SCOPE);
    const body = JSON.stringify({ Image: "alpine" });
    const client = openStream(
      sock,
      "POST /containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    await resolvesWithin(daemon.held, SETTLE_MS, "the create to reach the daemon");
    const unregistering = proxy.unregisterTask(SCOPE.taskId);

    await resolvesWithin(proxy.close(), SETTLE_MS, "close");

    await resolvesWithin(unregistering, SETTLE_MS, "the teardown that was waiting");
    await resolvesWithin(client.closed, SETTLE_MS, "the client connection to close");
    await resolvesWithin(daemon.closed, SETTLE_MS, "the daemon connection to close");
  });

  it("keeps the socket of a task registered again while its old socket's teardown waits", {
    timeout: STREAM_TEST_TIMEOUT_MS,
  }, async () => {
    const daemon = holdUpstreamOpen();
    const sock = await proxy.registerTask(SCOPE);
    const body = JSON.stringify({ Image: "alpine" });
    openStream(
      sock,
      "POST /containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    const held = await resolvesWithin(daemon.held, SETTLE_MS, "the create to reach the daemon");
    const unregistering = proxy.unregisterTask(SCOPE.taskId);
    await sleep(50);

    const again = await proxy.registerTask(SCOPE);
    held.end(JSON.stringify({ Id: CHILD_CONTAINER_ID }));
    await resolvesWithin(unregistering, SETTLE_MS, "the old socket's teardown");

    expect(again).toBe(sock);
    expect(await socketExists(again)).toBe(true);
  });

  it("close() does not wait for a create whose row is still being written", {
    timeout: STREAM_TEST_TIMEOUT_MS,
  }, async () => {
    const written = Promise.withResolvers<void>();
    childContainers.record.mockReturnValue(
      new ResultAsync(written.promise.then(() => ok<void, never>(undefined))),
    );
    upstreamResponder = (_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ Id: CHILD_CONTAINER_ID }));
    };
    const sock = await proxy.registerTask(SCOPE);
    void unixRequest(sock, "POST", "/containers/create", JSON.stringify({ Image: "alpine" })).catch(
      () => {},
    );
    await vi.waitFor(() => expect(childContainers.record).toHaveBeenCalledTimes(1));

    try {
      await resolvesWithin(proxy.close(), SETTLE_MS, "close");
    } finally {
      written.resolve();
    }
  });

  it("close() resolves once a teardown it found waiting has finished", {
    timeout: STREAM_TEST_TIMEOUT_MS,
  }, async () => {
    const written = Promise.withResolvers<void>();
    childContainers.record.mockReturnValue(
      new ResultAsync(written.promise.then(() => ok<void, never>(undefined))),
    );
    upstreamResponder = (_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ Id: CHILD_CONTAINER_ID }));
    };
    const sock = await proxy.registerTask(SCOPE);
    void unixRequest(sock, "POST", "/containers/create", JSON.stringify({ Image: "alpine" })).catch(
      () => {},
    );
    await vi.waitFor(() => expect(childContainers.record).toHaveBeenCalledTimes(1));
    let unregistered = false;
    void proxy.unregisterTask(SCOPE.taskId).then(() => {
      unregistered = true;
    });
    await sleep(50);

    try {
      await resolvesWithin(proxy.close(), SETTLE_MS, "close");
      expect(unregistered).toBe(true);
    } finally {
      written.resolve();
    }
  });

  it("unregisterTask does not wait for a create whose body is still arriving", {
    timeout: STREAM_TEST_TIMEOUT_MS,
  }, async () => {
    const sock = await proxy.registerTask(SCOPE);
    const client = openStream(
      sock,
      "POST /containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n" +
        'Content-Length: 100\r\n\r\n{"Image":',
    );
    await sleep(100);

    await resolvesWithin(proxy.unregisterTask(SCOPE.taskId), SETTLE_MS, "unregisterTask");
    await resolvesWithin(client.closed, SETTLE_MS, "the client connection to close");
  });

  it("answers unavailable on a connection the old socket accepted, after the task registers again", {
    timeout: STREAM_TEST_TIMEOUT_MS,
  }, async () => {
    // The daemon holds the create unanswered and answers everything else.
    const held = Promise.withResolvers<void>();
    const answer = upstreamResponder;
    upstreamResponder = (req, res) => {
      if (!(req.url ?? "").startsWith("/containers/create")) return answer(req, res);
      res.writeHead(201, { "content-type": "application/json" });
      res.flushHeaders();
      held.resolve();
    };
    const sock = await proxy.registerTask(SCOPE);
    const body = JSON.stringify({ Image: "alpine" });
    openStream(
      sock,
      "POST /containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    await resolvesWithin(held.promise, SETTLE_MS, "the create to reach the daemon");
    const plain = openStream(sock, "GET /_ping HTTP/1.1\r\nHost: docker\r\n\r\n");
    const upgrading = openStream(sock, "GET /_ping HTTP/1.1\r\nHost: docker\r\n\r\n");
    await vi.waitFor(() => expect(plain.received()).toContain("200 OK"), { timeout: SETTLE_MS });
    await vi.waitFor(() => expect(upgrading.received()).toContain("200 OK"), {
      timeout: SETTLE_MS,
    });
    const forwarded = upstreamRequests.length;

    void proxy.unregisterTask(SCOPE.taskId);
    await sleep(50);
    await proxy.registerTask(SCOPE);
    plain.write("GET /_ping HTTP/1.1\r\nHost: docker\r\n\r\n");
    upgrading.write(
      "POST /containers/abc/attach?stream=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
    );

    await vi.waitFor(() => expect(plain.received()).toContain("503 Service Unavailable"), {
      timeout: SETTLE_MS,
    });
    await vi.waitFor(() => expect(upgrading.received()).toContain("503 Service Unavailable"), {
      timeout: SETTLE_MS,
    });
    expect(upstreamRequests).toHaveLength(forwarded);
  });

  it("unregisterTask leaves another task's streams open", {
    timeout: STREAM_TEST_TIMEOUT_MS,
  }, async () => {
    const daemon = holdUpstreamOpen();
    await proxy.registerTask(SCOPE);
    const other = "019d0000-0000-7000-8000-0000000000b2";
    const sock = await proxy.registerTask({ ...SCOPE, taskId: other });
    const client = openStream(sock, "GET /events HTTP/1.1\r\nHost: docker\r\n\r\n");
    const events = await resolvesWithin(daemon.held, SETTLE_MS, "the request to reach the daemon");

    await proxy.unregisterTask(SCOPE.taskId);

    events.write(
      `${JSON.stringify({ status: "start", Actor: { ID: TASK_CONTAINER_ID, Attributes: {} } })}\n`,
    );
    await vi.waitFor(() => expect(client.received()).toContain('"status":"start"'), {
      timeout: SETTLE_MS,
    });
  });

  it("a close() racing registerTask leaves no listener behind", async () => {
    const registering = expect(proxy.registerTask(SCOPE)).rejects.toThrow("proxy is closed");
    await proxy.close();

    await registering;
    expect(await socketExists(join(baseDir, "sockets", `${SCOPE.taskId}.sock`))).toBe(false);
  });

  it("an unregisterTask racing registerTask leaves no listener behind", async () => {
    const registering = expect(proxy.registerTask(SCOPE)).rejects.toThrow(
      "task socket unregistered",
    );
    await proxy.unregisterTask(SCOPE.taskId);

    await registering;
    expect(await socketExists(join(baseDir, "sockets", `${SCOPE.taskId}.sock`))).toBe(false);
  });

  it("registers a task again after its socket failed to bind", async () => {
    const blocker = join(baseDir, "sockets", `${SCOPE.taskId}.sock`);
    await mkdir(blocker);
    await expect(proxy.registerTask(SCOPE)).rejects.toThrow();

    await rmdir(blocker);

    const sock = await proxy.registerTask(SCOPE);
    expect(await socketExists(sock)).toBe(true);
  });

  it("close() tears down all task sockets", async () => {
    const sockA = await proxy.registerTask({
      ...SCOPE,
      taskId: "019d0000-0000-7000-8000-0000000000a1",
    });
    const sockB = await proxy.registerTask({
      ...SCOPE,
      taskId: "019d0000-0000-7000-8000-0000000000b2",
    });
    await proxy.close();
    expect(await socketExists(sockA)).toBe(false);
    expect(await socketExists(sockB)).toBe(false);
  });
});

describe("CogmoSocketProxy hijack/forward — fuzz the transcript", () => {
  it("forwards a plain GET under its canonical path and re-serialised query", async () => {
    upstreamResponder = (_req, res) => {
      res.writeHead(200);
      res.end("hello");
    };
    const sock = await proxy.registerTask(SCOPE);
    const r = await unixRequest(sock, "GET", "/images//./json?all=1&filter=a%20b");
    expect(r.body).toBe("hello");
    expect(expectDefined(upstreamRequests[0], "GET /images/json request").url).toBe(
      "/images/json?all=1&filter=a+b",
    );
  });

  it("forwards POST /containers/create with chunked transfer encoding", async () => {
    // grammY / docker compose can chunk-encode larger creates. Buffering
    // through readBody works regardless of framing — assert that the
    // mutated body still reaches the upstream.
    upstreamResponder = (_req, res) => {
      res.writeHead(201);
      res.end(JSON.stringify({ Id: CHILD_CONTAINER_ID }));
    };
    const sock = await proxy.registerTask(SCOPE);
    const body = JSON.stringify({ Image: "alpine" });

    // Manually write a chunked HTTP/1.1 request: split the body into two
    // chunks plus the terminating `0\r\n\r\n`. http.request with
    // chunked encoding requires Content-Length undefined + Transfer-
    // Encoding: chunked.
    const split = Math.floor(body.length / 2);
    const chunk1 = body.slice(0, split);
    const chunk2 = body.slice(split);
    const raw = [
      "POST /containers/create HTTP/1.1",
      `Host: docker`,
      `Transfer-Encoding: chunked`,
      `Content-Type: application/json`,
      `Connection: close`,
      "",
      `${chunk1.length.toString(16)}\r\n${chunk1}`,
      `${chunk2.length.toString(16)}\r\n${chunk2}`,
      "0",
      "",
      "",
    ].join("\r\n");

    const client = net.createConnection({ path: sock });
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write(raw);
    const response: Buffer[] = [];
    await new Promise<void>((resolve) => {
      client.on("data", (c: Buffer) => response.push(c));
      client.on("close", () => resolve());
    });
    const reply = Buffer.concat(response).toString("utf8");
    expect(reply).toContain("201");

    expect(upstreamCreates()).toHaveLength(1);
    const seen = parseContainerCreate(
      expectDefined(upstreamCreates()[0], "chunked create request").body,
    );
    expect(seen.Image).toBe(IMAGE_ID);
    // The rebuild applies through chunked encoding the same as Content-Length.
    expect(seen.HostConfig?.CgroupParent).toBe("cogmo-task-abc.slice");
    expect(seen.Labels?.["cogmo.managed"]).toBe("true");
  });

  it("rejects POST /containers/create with body > 1 MiB cap", async () => {
    const sock = await proxy.registerTask(SCOPE);
    // 2 MiB body — well over the 1 MiB cap.
    const oversized = "x".repeat(2 * 1024 * 1024);
    const huge = JSON.stringify({ Image: "alpine", Cmd: [oversized] });
    const r = await unixRequest(sock, "POST", "/containers/create", huge);
    expect(r.status).toBe(413);
    expect(parseError(r.body).message).toContain("body exceeds");
    expect(upstreamRequests).toHaveLength(0);
  });

  it("rejects an Upgrade request to a denied path (/swarm) without forwarding", async () => {
    const sock = await proxy.registerTask(SCOPE);
    const client = net.createConnection({ path: sock });
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write(
      [
        "GET /swarm/inspect HTTP/1.1",
        "Host: docker",
        "Upgrade: tcp",
        "Connection: Upgrade",
        "",
        "",
      ].join("\r\n"),
    );
    const buf: Buffer[] = [];
    await new Promise<void>((resolve) => {
      client.on("data", (c: Buffer) => buf.push(c));
      client.on("close", () => resolve());
    });
    const reply = Buffer.concat(buf).toString("utf8");
    expect(reply).toContain("403");
    expect(reply).toContain("swarm");
    expect(upstreamRequests).toHaveLength(0);
  });

  it("rejects an Upgrade request to a container create with 400, without forwarding", async () => {
    const sock = await proxy.registerTask(SCOPE);
    const client = net.createConnection({ path: sock });
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write(
      [
        "POST /containers/create HTTP/1.1",
        "Host: docker",
        "Upgrade: tcp",
        "Connection: Upgrade",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"),
    );
    const buf: Buffer[] = [];
    await new Promise<void>((resolve) => {
      client.on("data", (c: Buffer) => buf.push(c));
      client.on("close", () => resolve());
    });
    const reply = Buffer.concat(buf).toString("utf8");
    expect(reply).toContain("400 Bad Request");
    expect(reply).toContain("cannot be upgraded");
    expect(upstreamRequests).toHaveLength(0);
  });

  it("client error logs without crashing the server", async () => {
    const sock = await proxy.registerTask(SCOPE);
    // Send garbage HTTP — proxy should reset and stay alive.
    const client = net.createConnection({ path: sock });
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write("HTTP/garbage\r\n\r\n");
    // Wait for the server to close the connection.
    await new Promise<void>((resolve) => client.once("close", () => resolve()));
    // Proxy still serves new connections.
    upstreamResponder = (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    };
    const r = await unixRequest(sock, "GET", "/_ping");
    expect(r.status).toBe(200);
  });
});

/**
 * Make the daemon answer with headers and hold the response open, as it does
 * for `GET /events`, `logs -f` and `POST /containers/{id}/wait`. `held`
 * resolves with the response once the request reaches the daemon; `closed`
 * once the daemon-side connection closes.
 */
function holdUpstreamOpen(): { held: Promise<http.ServerResponse>; closed: Promise<void> } {
  const held = Promise.withResolvers<http.ServerResponse>();
  const closed = Promise.withResolvers<void>();
  upstreamResponder = (req, res) => {
    req.socket.once("close", () => closed.resolve());
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    held.resolve(res);
  };
  return { held: held.promise, closed: closed.promise };
}

/**
 * Once the request reaches the daemon, `unregisterTask` resolves and ends
 * both the client connection and the proxy's connection to the daemon.
 */
async function expectUnregisterEnds(
  daemon: { held: Promise<unknown>; closed: Promise<void> },
  client: { closed: Promise<void> },
): Promise<void> {
  await resolvesWithin(daemon.held, SETTLE_MS, "the request to reach the daemon");
  await resolvesWithin(proxy.unregisterTask(SCOPE.taskId), SETTLE_MS, "unregisterTask");
  await resolvesWithin(client.closed, SETTLE_MS, "the client connection to close");
  await resolvesWithin(daemon.closed, SETTLE_MS, "the daemon connection to close");
}

/** Send a raw request on a task socket; `received` is everything read back so far. */
function openStream(
  socketPath: string,
  request: string,
): { closed: Promise<void>; received: () => string; write: (more: string) => void } {
  const socket = net.createConnection({ path: socketPath });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  // A reset is an acceptable way for the proxy to end the stream.
  socket.on("error", () => {});
  let received = "";
  socket.on("data", (chunk: Buffer) => {
    received += chunk.toString("utf8");
  });
  socket.once("connect", () => socket.write(request));
  return { closed, received: () => received, write: (more) => socket.write(more) };
}

async function socketExists(p: string): Promise<boolean> {
  try {
    const s = net.createConnection({ path: p });
    await new Promise<void>((resolve, reject) => {
      s.once("connect", () => {
        s.destroy();
        resolve();
      });
      s.once("error", reject);
    });
    return true;
  } catch {
    return false;
  }
}

// Silence the noop usage-warnings in CI:
void vi;
