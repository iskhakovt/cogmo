import * as net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { expectDefined, resolvesWithin } from "../../test/assertions.js";
import { respondJson } from "../../test/fake-docker-daemon.js";
import { API, OWN, upgradeRequest, useProxyHarness } from "../../test/proxy-harness.js";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../logger.js", () => ({ logger: { child: () => log } }));

const ExecCreatedSchema = z.object({ Id: z.string() });

/** Budget for each wait on a connection; ample headroom over the milliseconds they take. */
const SETTLE_MS = 2_500;

const h = useProxyHarness();

/** A raw client on the task's socket, collecting everything it reads. */
async function rawClient(): Promise<{ socket: net.Socket; received: () => string }> {
  const socket = net.createConnection({ path: h.socket });
  socket.on("error", () => {});
  let received = "";
  socket.on("data", (c: Buffer) => {
    received += c.toString("utf8");
  });
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  return { socket, received: () => received };
}

async function createExec(): Promise<string> {
  const r = await h.send(
    "POST",
    "/containers/cogmo-task-own/exec",
    JSON.stringify({ Cmd: ["id"] }),
  );
  expect(r.status, r.body).toBe(201);
  return ExecCreatedSchema.parse(JSON.parse(r.body)).Id;
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The request lines whose headers reached the daemon and that contain `marker`. */
function reached(marker: string): string[] {
  return h.daemon.started().filter((line) => line.includes(marker));
}

/** Header lines enough to reach the server's count, and past Node's default of 2000. */
const MANY_HEADERS = Array.from({ length: 2000 }, () => "a: 1").join("\r\n");

const SIBLING_KILL =
  "POST /containers/cogmo-task-sibling/kill HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\n\r\n";
const PRIVILEGED = JSON.stringify({ Image: "alpine:3", HostConfig: { Privileged: true } });
const PRIVILEGED_CREATE =
  "POST /containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n" +
  `Content-Length: ${Buffer.byteLength(PRIVILEGED)}\r\n\r\n${PRIVILEGED}`;

describe("a request pipelined after a streaming one", () => {
  it("is answered in order, after a held logs stream, and classified on its own", async () => {
    const release = Promise.withResolvers<void>();
    h.daemon.setResponder((req, res, raw) => {
      if (!req.url.startsWith(`/containers/${OWN.id}/logs`)) return API(req, res, raw);
      res.writeHead(200, { "content-type": "application/vnd.docker.multiplexed-stream" });
      res.write("first");
      release.promise.then(() => res.end("last"));
    });
    const client = await rawClient();
    client.socket.write(
      "GET /containers/cogmo-task-own/logs?follow=1&stdout=1 HTTP/1.1\r\nHost: docker\r\n\r\n",
    );
    await vi.waitFor(() => expect(client.received()).toContain("first"));

    client.socket.write("GET /unlisted HTTP/1.1\r\nHost: docker\r\n\r\n");
    await settle(100);
    expect(client.received()).not.toContain("HTTP/1.1 403");
    release.resolve();

    await vi.waitFor(() => expect(client.received()).toContain("HTTP/1.1 403"));
    const received = client.received();
    expect(received.indexOf("HTTP/1.1 200")).toBeLessThan(received.indexOf("HTTP/1.1 403"));
    expect(received.indexOf("last")).toBeLessThan(received.indexOf("HTTP/1.1 403"));
    expect(h.daemon.started()).toEqual([
      "GET /containers/cogmo-task-own/json",
      `GET /containers/${OWN.id}/logs?follow=1&stdout=1`,
    ]);
    client.socket.destroy();
  });

  it.each([
    [
      "a distribution lookup",
      async () => "GET /distribution/alpine/json HTTP/1.1\r\nHost: docker\r\n\r\n",
      "/distribution/alpine/json",
    ],
    [
      "a detached exec start without Upgrade",
      async () => {
        const id = await createExec();
        return (
          `POST /exec/${id}/start HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n` +
          `Content-Length: 15\r\n\r\n{"Detach":true}`
        );
      },
      "/start",
    ],
  ])("is answered in order after %s whose response is held", async (_label, first, held) => {
    const request = await first();
    const release = Promise.withResolvers<void>();
    h.daemon.setResponder((req, res, raw) => {
      if (!req.url.endsWith(held)) return API(req, res, raw);
      release.promise.then(() => respondJson(res, 200, {}));
    });
    const client = await rawClient();
    client.socket.write(request);
    await vi.waitFor(() => expect(reached(held)).toHaveLength(1));

    client.socket.write("GET /unlisted HTTP/1.1\r\nHost: docker\r\n\r\n");
    await settle(100);
    expect(client.received()).toBe("");
    release.resolve();

    await vi.waitFor(() => expect(client.received()).toContain("HTTP/1.1 403"));
    const received = client.received();
    expect(received.indexOf("HTTP/1.1 200")).toBeGreaterThan(-1);
    expect(received.indexOf("HTTP/1.1 200")).toBeLessThan(received.indexOf("HTTP/1.1 403"));
    expect(reached("/unlisted")).toEqual([]);
    client.socket.destroy();
  });

  it.each([
    [
      "an owned logs",
      "GET /containers/cogmo-task-own/logs?stdout=1 HTTP/1.1\r\nHost: docker\r\n\r\n",
      SIBLING_KILL,
      "404",
      "/kill",
    ],
    [
      "a distribution lookup",
      "GET /distribution/alpine/json HTTP/1.1\r\nHost: docker\r\n\r\n",
      PRIVILEGED_CREATE,
      "403",
      "/containers/create",
    ],
  ])("is classified on its own after %s", async (_label, first, second, status, marker) => {
    const client = await rawClient();
    client.socket.write(first);
    await vi.waitFor(() => expect(client.received()).toContain("HTTP/1.1 200"));

    client.socket.write(second);

    await vi.waitFor(() => expect(client.received()).toContain(`HTTP/1.1 ${status}`));
    await settle(200);
    expect(reached(marker)).toEqual([]);
    client.socket.destroy();
  });

  it("is classified on its own after a detached exec start without Upgrade", async () => {
    const id = await createExec();
    const client = await rawClient();
    const body = '{"Detach":true}';
    // The body follows the headers late, as a client may send it.
    client.socket.write(
      `POST /exec/${id}/start HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${body.length}\r\n\r\n`,
    );
    await settle(200);
    client.socket.write(body);
    await vi.waitFor(() => expect(client.received()).toContain("HTTP/1.1 200"));
    expect(h.daemon.requests().find((r) => r.url === `/exec/${id}/start`)?.body).toBe(body);

    client.socket.write(SIBLING_KILL);

    await vi.waitFor(() => expect(client.received()).toContain("HTTP/1.1 404"));
    await settle(200);
    expect(reached("/kill")).toEqual([]);
    client.socket.destroy();
  });
});

describe("a client gone during the checks", () => {
  /** Send `request`, and hang up while the daemon holds the lookup for `held`. */
  async function hangUpDuringLookup(request: string, held: string): Promise<void> {
    const release = Promise.withResolvers<void>();
    h.daemon.setResponder((req, res, raw) => {
      if (req.url === held) {
        release.promise.then(() => API(req, res, raw));
        return;
      }
      API(req, res, raw);
    });
    const client = await rawClient();
    client.socket.write(request);
    await vi.waitFor(() => expect(h.daemon.started()).toContain(`GET ${held}`));
    client.socket.destroy();
    await settle(100);
    release.resolve();
    await settle(200);
  }

  it("leaves no daemon request holding a connection for a wait", async () => {
    await hangUpDuringLookup(
      "POST /containers/cogmo-task-own/wait HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\n\r\n",
      "/containers/cogmo-task-own/json",
    );
    const connections = h.daemon.connections();

    const r = await h.send("GET", "/containers/cogmo-task-own/json");

    expect(r.status, r.body).toBe(200);
    expect(reached("/wait")).toEqual([]);
    expect(h.daemon.connections()).toBe(connections);
  });

  it("does not send an exec create", async () => {
    const body = JSON.stringify({ Cmd: ["id"] });
    await hangUpDuringLookup(
      "POST /containers/cogmo-task-own/exec HTTP/1.1\r\nHost: docker\r\n" +
        `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      "/containers/cogmo-task-own/json",
    );

    expect(reached("/exec")).toEqual([]);
  });

  it("still sends a container create", async () => {
    const body = JSON.stringify({ Image: "alpine:3" });
    await hangUpDuringLookup(
      "POST /containers/create HTTP/1.1\r\nHost: docker\r\n" +
        `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      "/images/alpine:3/json",
    );

    expect(reached("/containers/create")).toEqual(["POST /containers/create"]);
  });
});

describe("an upgrade the daemon refuses", () => {
  const PRIVILEGED = JSON.stringify({
    Image: "alpine:3",
    HostConfig: { Privileged: true, Binds: ["/:/host"] },
  });
  const CREATE =
    "POST /containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n" +
    `Content-Length: ${Buffer.byteLength(PRIVILEGED)}\r\n\r\n${PRIVILEGED}`;

  function upgradeStart(id: string, body: string): string {
    return (
      `POST /exec/${id}/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`
    );
  }

  it.each([
    ["a detached start", '{"Detach":true}', "200"],
    ["a start whose body the daemon rejects", '{"Detach":', "400"],
  ])(
    "forwards the body of %s, and the create pipelined after it never reaches the daemon",
    async (_label, body, status) => {
      const id = await createExec();
      const client = await rawClient();
      client.socket.write(upgradeStart(id, body));
      await vi.waitFor(() => expect(client.received()).toContain(`HTTP/1.1 ${status}`));
      const start = expectDefined(
        h.daemon.requests().find((r) => r.url === `/exec/${id}/start`),
        "the upgrade",
      );
      expect(start.body).toBe(body);
      expect(start.headers.connection).toBe("Upgrade, close");

      client.socket.write(CREATE);

      await settle(300);
      expect(reached("/containers/create")).toEqual([]);
      client.socket.destroy();
    },
  );

  it.each([
    ["a detached start", '{"Detach":true}', "200"],
    ["a start whose body the daemon rejects", '{"Detach":', "400"],
  ])("keeps the create out after %s, its body sent again raw", async (_label, body, status) => {
    const id = await createExec();
    const client = await rawClient();
    client.socket.write(upgradeStart(id, body));
    await settle(200);
    client.socket.write(body);
    await vi.waitFor(() => expect(client.received()).toContain(`HTTP/1.1 ${status}`));

    client.socket.write(CREATE);

    await settle(300);
    expect(reached("/containers/create")).toEqual([]);
    client.socket.destroy();
  });

  it("forwards an upgrade that switches, its body with it", async () => {
    const id = await createExec();
    const body = '{"Detach":false,"Tty":false}';

    const reply = await resolvesWithin(
      h.rawExchange(upgradeStart(id, body)),
      SETTLE_MS,
      "the daemon to answer the upgrade",
    );

    expect(reply).toMatch(/^HTTP\/1\.1 101 /);
    const start = expectDefined(
      h.daemon.requests().find((r) => r.url === `/exec/${id}/start`),
      "the upgrade",
    );
    expect(start.body).toBe(body);
  });
});

describe("the checks on an upgrade", () => {
  function upgradeWith(id: string, headers: string, body: string): string {
    return (
      `POST /exec/${id}/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n` +
      `${headers}Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    );
  }

  it("answers 431 to an upgrade past the header count, reaching nothing", async () => {
    const id = await createExec();
    const before = h.daemon.started();

    const reply = await h.rawExchange(upgradeWith(id, `${MANY_HEADERS}\r\n`, ""));

    expect(reply).toMatch(/^HTTP\/1\.1 431 /);
    expect(h.daemon.started()).toEqual(before);
  });

  it("answers 417 to an upgrade that expects 100 Continue, forwarding nothing", async () => {
    const id = await createExec();
    const before = h.daemon.started();
    const client = await rawClient();
    // The headers alone: a client that expects 100 Continue holds its body back.
    client.socket.write(
      `POST /exec/${id}/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n` +
        "Expect: 100-continue\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n",
    );

    await vi.waitFor(() => expect(client.received()).toMatch(/^HTTP\/1\.1 417 /));
    expect(h.daemon.started()).toEqual(before);
    client.socket.destroy();
  });

  it("answers 413 to an upgrade body over 1 MiB, reaching nothing", async () => {
    const id = await createExec();
    const before = h.daemon.started();

    const client = await rawClient();

    client.socket.write(
      upgradeWith(id, "", JSON.stringify({ Detach: false, pad: "x".repeat(2 * 1024 * 1024) })),
    );

    // The client is still writing, so the answer, not a close, is what it sees.
    await vi.waitFor(() => expect(client.received()).toMatch(/^HTTP\/1\.1 413 /), {
      timeout: SETTLE_MS,
    });
    expect(h.daemon.started()).toEqual(before);
    client.socket.destroy();
  });

  it("rejects an upgrade body that ends early as malformed, reaching nothing", async () => {
    const id = await createExec();
    const before = h.daemon.started();
    const client = await rawClient();
    const closed = new Promise<void>((resolve) => client.socket.once("close", () => resolve()));
    const body = '{"Detach":false}';
    log.info.mockClear();
    client.socket.write(
      `POST /exec/${id}/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${body.length + 10}\r\n\r\n${body}`,
    );
    await settle(100);

    // The client stops writing with its body ten bytes short. A task socket
    // does not allow half-open connections, so no answer can follow its FIN.
    client.socket.end();

    await resolvesWithin(closed, SETTLE_MS, "the connection to close");
    await vi.waitFor(() =>
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ rejection: expect.objectContaining({ kind: "malformed" }) }),
        "proxy request rejected",
      ),
    );
    expect(h.daemon.started()).toEqual(before);
  });

  it("sends a refused upgrade's body once, and the bytes after it no further", async () => {
    const id = await createExec();
    const before = h.daemon.requests().length;
    const client = await rawClient();
    const closed = new Promise<void>((resolve) => client.socket.once("close", () => resolve()));
    const body = '{"Detach":true}';

    client.socket.write(`${upgradeWith(id, "", body)}OPAQUE-MARKER-BYTES`);

    await resolvesWithin(closed, SETTLE_MS, "the connection to close");
    expect(client.received()).toMatch(/^HTTP\/1\.1 200 /);
    const sent = h.daemon.requests().slice(before);
    expect(sent.map((r) => `${r.method} ${r.url}`)).toEqual([`POST /exec/${id}/start`]);
    const start = expectDefined(sent[0], "the upgrade");
    expect(start.body).toBe(body);
    expect(start.headers.connection).toBe("Upgrade, close");
  });

  it.each([
    ["a denied route", "GET", "/swarm"],
    ["a request route", "GET", "/containers/cogmo-task-own/logs"],
    ["an exec the socket did not create", "POST", `/exec/${"e".repeat(64)}/start`],
  ])("logs the rejection of an upgrade to %s", async (_label, method, path) => {
    log.info.mockClear();

    await h.rawExchange(upgradeRequest(method, path));

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        path,
        rejection: expect.objectContaining({ kind: expect.any(String) }),
      }),
      "proxy request rejected",
    );
  });
});

describe("streams and relays", () => {
  it.each([
    [
      "a wait",
      "POST",
      "/containers/cogmo-task-own/wait?condition=next-exit",
      `/containers/${OWN.id}/wait`,
    ],
    ["a quiet event stream", "GET", "/events", "/events"],
  ])("relays %s's status and headers before any body", async (_label, method, path, atDaemon) => {
    h.daemon.setResponder((req, res, raw) => {
      if (!req.url.startsWith(atDaemon)) return API(req, res, raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
    });
    const client = await rawClient();

    client.socket.write(`${method} ${path} HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\n\r\n`);

    await vi.waitFor(() =>
      expect(client.received()).toMatch(/^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\n$/),
    );
    client.socket.destroy();
  });

  it.each([
    ["a stats stream", "GET", "stats", true],
    ["a wait the daemon has not answered", "POST", "wait", false],
  ])(
    "closes the daemon request when the client hangs up on %s, logging no upstream error",
    async (_label, method, action, answered) => {
      const closed = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      h.daemon.setResponder((req, res, raw) => {
        if (!req.url.startsWith(`/containers/${OWN.id}/${action}`)) return API(req, res, raw);
        raw.socket.once("close", () => closed.resolve());
        if (answered) {
          res.writeHead(200, { "content-type": "application/json" });
          res.write("{}\n");
        }
        held.resolve();
      });
      const client = net.createConnection({ path: h.socket });
      client.on("error", () => {});
      await new Promise<void>((resolve) => client.once("connect", () => resolve()));
      client.write(
        `${method} /containers/cogmo-task-own/${action} HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\n\r\n`,
      );
      await resolvesWithin(held.promise, SETTLE_MS, "the request to reach the daemon");

      client.destroy();

      await resolvesWithin(closed.promise, SETTLE_MS, "the daemon connection to close");
      await settle(100);
      expect(log.warn.mock.calls.filter(([, msg]) => msg === "upstream error")).toEqual([]);
    },
  );

  it.each([
    ["GET", "/containers/cogmo-task-own/logs"],
    ["GET", "/distribution/alpine/json"],
  ])("answers 400 to an upgrade on %s %s, which is not a stream route", async (method, path) => {
    const reply = await h.rawExchange(upgradeRequest(method, path));

    expect(reply).toMatch(/^HTTP\/1\.1 400 /);
    expect(h.received()).toEqual([]);
  });

  it("answers 502 to a forwarded stream whose daemon connection fails", async () => {
    await h.daemon.close();

    const r = await h.send("GET", "/distribution/alpine/json");

    expect(r.status, r.body).toBe(502);
  });

  it("answers 502 to an upgrade whose daemon connection fails", async () => {
    const id = await createExec();
    await h.daemon.close();

    const reply = await h.rawExchange(upgradeRequest("POST", `/exec/${id}/start`));

    expect(reply).toMatch(/^HTTP\/1\.1 502 /);
  });

  it("answers 502 to an upgrade the daemon resets before its first byte", async () => {
    const id = await createExec();
    await h.daemon.close();
    // A paused socket reads nothing, so closing it with the request unread resets the proxy's side.
    const resetter = net.createServer({ pauseOnConnect: true }, (socket) => {
      setTimeout(() => socket.destroy(), 50);
    });
    await new Promise<void>((resolve) => resetter.listen(h.daemon.socketPath, resolve));
    try {
      const reply = await resolvesWithin(
        h.rawExchange(upgradeRequest("POST", `/exec/${id}/start`)),
        SETTLE_MS,
        "the proxy to answer",
      );

      expect(reply).toMatch(/^HTTP\/1\.1 502 /);
    } finally {
      await new Promise<void>((resolve) => resetter.close(() => resolve()));
    }
  });
});
