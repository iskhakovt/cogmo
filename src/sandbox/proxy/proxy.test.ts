import { mkdtemp, rm } from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CogmoSocketProxy } from "./index.js";
import type { TaskScope } from "./types.js";

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

const SCOPE: TaskScope = {
  taskId: "019d0000-0000-7000-8000-00000000aaaa",
  parentContainerRowId: "019d0000-0000-7000-8000-00000000bbbb",
  parentDockerId: "docker-parent-abc",
  parentDepth: 0,
  runtime: "sysbox-runc",
  cgroupParent: "cogmo-task-abc.slice",
  instanceId: "019d0000-0000-7000-8000-0000000000ff",
};

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
      upstreamResponder(req, res);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(upstreamSocketPath, resolve));

  proxy = await CogmoSocketProxy.create({
    socketDir: join(baseDir, "sockets"),
    hostDockerSocket: upstreamSocketPath,
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
    expect(upstreamRequests[0].method).toBe("GET");
    expect(upstreamRequests[0].url).toBe("/version");
  });

  it("denies /swarm/* with 403 without contacting upstream", async () => {
    const sock = await proxy.registerTask(SCOPE);
    const r = await unixRequest(sock, "GET", "/swarm/inspect");
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).message).toContain("swarm");
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
    expect(JSON.parse(r.body).message).toContain("Privileged");
    expect(upstreamRequests).toHaveLength(0);
  });

  it("forwards POST /containers/create with mutated body — labels + runtime + cgroup parent injected", async () => {
    upstreamResponder = (_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end('{"Id":"new-container-abc","Warnings":[]}');
    };
    const sock = await proxy.registerTask(SCOPE);
    const r = await unixRequest(
      sock,
      "POST",
      "/containers/create",
      JSON.stringify({ Image: "alpine", Labels: { "user.foo": "bar" } }),
    );
    expect(r.status).toBe(201);

    expect(upstreamRequests).toHaveLength(1);
    const seen = JSON.parse(upstreamRequests[0].body);
    expect(seen.Image).toBe("alpine");
    expect(seen.HostConfig.Runtime).toBe("sysbox-runc");
    expect(seen.HostConfig.CgroupParent).toBe("cogmo-task-abc.slice");
    expect(seen.Labels["user.foo"]).toBe("bar");
    expect(seen.Labels["cogmo.managed"]).toBe("true");
    expect(seen.Labels["cogmo.parent"]).toBe("docker-parent-abc");
    expect(seen.Labels["cogmo.depth"]).toBe("1");
    // Re-supplied content-length matches the mutated body length.
    expect(upstreamRequests[0].headers["content-length"]).toBe(
      String(Buffer.byteLength(upstreamRequests[0].body)),
    );
  });

  it("propagates upstream errors as 502 when upstream socket isn't writable", async () => {
    // Close upstream immediately to make connections fail.
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    const sock = await proxy.registerTask(SCOPE);
    const r = await unixRequest(sock, "GET", "/version");
    expect(r.status).toBe(502);
  });

  it("DELETE /containers/abc forwards (slice 3 ownership check lands in 3.0f)", async () => {
    upstreamResponder = (_req, res) => {
      res.writeHead(204);
      res.end();
    };
    const sock = await proxy.registerTask(SCOPE);
    const r = await unixRequest(sock, "DELETE", "/containers/abc");
    expect(r.status).toBe(204);
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0].method).toBe("DELETE");
  });

  it("isolates task scopes — two registered tasks each get their own socket", async () => {
    upstreamResponder = (_req, res) => {
      res.writeHead(201);
      res.end('{"Id":"x"}');
    };
    const taskA: TaskScope = { ...SCOPE, taskId: "019d0000-0000-7000-8000-0000000000a1" };
    const taskB: TaskScope = {
      ...SCOPE,
      taskId: "019d0000-0000-7000-8000-0000000000b2",
      parentDockerId: "docker-parent-different",
      cgroupParent: "cogmo-task-b.slice",
    };
    const sockA = await proxy.registerTask(taskA);
    const sockB = await proxy.registerTask(taskB);

    await unixRequest(sockA, "POST", "/containers/create", JSON.stringify({ Image: "alpine" }));
    await unixRequest(sockB, "POST", "/containers/create", JSON.stringify({ Image: "alpine" }));

    expect(upstreamRequests).toHaveLength(2);
    const seenA = JSON.parse(upstreamRequests[0].body);
    const seenB = JSON.parse(upstreamRequests[1].body);
    expect(seenA.HostConfig.CgroupParent).toBe("cogmo-task-abc.slice");
    expect(seenA.Labels["cogmo.root_task"]).toBe(taskA.taskId);
    expect(seenB.HostConfig.CgroupParent).toBe("cogmo-task-b.slice");
    expect(seenB.Labels["cogmo.root_task"]).toBe(taskB.taskId);
    expect(seenB.Labels["cogmo.parent"]).toBe("docker-parent-different");
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
  it("forwards request method, path, and body verbatim on plain GET", async () => {
    upstreamResponder = (_req, res) => {
      res.writeHead(200);
      res.end("hello");
    };
    const sock = await proxy.registerTask(SCOPE);
    const r = await unixRequest(sock, "GET", "/foo?bar=baz");
    expect(r.body).toBe("hello");
    expect(upstreamRequests[0].url).toBe("/foo?bar=baz");
  });

  it("forwards POST /containers/create with chunked transfer encoding", async () => {
    // grammY / docker compose can chunk-encode larger creates. Buffering
    // through readBody works regardless of framing — assert that the
    // mutated body still reaches the upstream.
    upstreamResponder = (_req, res) => {
      res.writeHead(201);
      res.end('{"Id":"chunk-id"}');
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

    expect(upstreamRequests).toHaveLength(1);
    const seen = JSON.parse(upstreamRequests[0].body);
    expect(seen.Image).toBe("alpine");
    // Mutations applied through chunked-encoding the same as Content-Length.
    expect(seen.HostConfig.CgroupParent).toBe("cogmo-task-abc.slice");
    expect(seen.Labels["cogmo.managed"]).toBe("true");
  });

  it("rejects POST /containers/create with body > 1 MiB cap", async () => {
    const sock = await proxy.registerTask(SCOPE);
    // 2 MiB body — well over the 1 MiB cap.
    const oversized = "x".repeat(2 * 1024 * 1024);
    const huge = JSON.stringify({ Image: "alpine", Cmd: [oversized] });
    const r = await unixRequest(sock, "POST", "/containers/create", huge);
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body).message).toContain("body exceeds");
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
