import * as net from "node:net";
import { ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { expectDefined, resolvesWithin } from "../../test/assertions.js";
import { dockerCliAttach, dockerCliExecStart } from "../../test/docker-cli-upgrade-requests.js";
import { respondJson } from "../../test/fake-docker-daemon.js";
import {
  API,
  fillerHeaders,
  OWN,
  TASK_ID,
  TASK_ROWS,
  upgradeRequest,
  upgradeRequestWith,
  useProxyHarness,
} from "../../test/proxy-harness.js";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../logger.js", () => ({ logger: { child: () => log } }));

const ExecCreatedSchema = z.object({ Id: z.string() });

/** Budget for each wait on a connection; ample headroom over the milliseconds they take. */
const SETTLE_MS = 2_500;

const h = useProxyHarness();

interface HalfOpenClient {
  socket: net.Socket;
  /** Everything read so far, as latin1. */
  received(): string;
  /** Resolves once the proxy has ended its side. */
  ended: Promise<void>;
  closed: Promise<void>;
}

/**
 * A raw client on the task's socket that keeps its side open after the
 * proxy ends its own, as the Docker CLI's hijacked connection does.
 */
async function halfOpenClient(): Promise<HalfOpenClient> {
  const socket = net.createConnection({ path: h.socket, allowHalfOpen: true });
  socket.on("error", () => {});
  let received = "";
  socket.on("data", (c: Buffer) => {
    received += c.toString("latin1");
  });
  const ended = new Promise<void>((resolve) => socket.once("end", () => resolve()));
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  return { socket, received: () => received, ended, closed };
}

/**
 * Wait until `client` has read a whole raw answer matching `answer`, then
 * keep writing, as a client that never ends its side, until the proxy
 * releases the connection.
 */
async function expectReleasedAfter(client: HalfOpenClient, answer: RegExp): Promise<void> {
  await vi.waitFor(() => expect(client.received()).toMatch(answer));
  const writing = setInterval(() => client.socket.write("more"), 25);
  try {
    await resolvesWithin(client.closed, SETTLE_MS, "the proxy to release the connection");
  } finally {
    clearInterval(writing);
  }
}

/** A raw rejection with `status`, whole: the proxy's answers end in a JSON line. */
function rawAnswer(status: number): RegExp {
  return new RegExp(`^HTTP/1\\.1 ${status} [\\s\\S]*\\r\\n\\r\\n\\{.*\\}\\n$`);
}

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

/** An exec start asking to upgrade: Host, Connection and Upgrade, then `headers`, then the body's two. */
function upgradeWith(id: string, headers: string, body: string): string {
  return (
    `POST /exec/${id}/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n` +
    `${headers}Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}

function upgradeStart(id: string, body: string): string {
  return upgradeWith(id, "", body);
}

const SIBLING_KILL =
  "POST /containers/cogmo-task-sibling/kill HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\n\r\n";
const PRIVILEGED = JSON.stringify({ Image: "alpine:3", HostConfig: { Privileged: true } });
const PRIVILEGED_CREATE =
  "POST /containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n" +
  `Content-Length: ${Buffer.byteLength(PRIVILEGED)}\r\n\r\n${PRIVILEGED}`;

describe("a request pipelined after a streaming one", () => {
  it("closes the connection on an upgrade behind a held logs stream, writing nothing into it", async () => {
    const id = await createExec();
    const release = Promise.withResolvers<void>();
    h.daemon.setResponder((req, res, raw) => {
      if (!req.url.startsWith(`/containers/${OWN.id}/logs`)) return API(req, res, raw);
      res.writeHead(200, { "content-type": "application/vnd.docker.multiplexed-stream" });
      res.write("first");
      release.promise.then(() => res.end("last"));
    });
    const client = await halfOpenClient();
    client.socket.write(
      "GET /containers/cogmo-task-own/logs?follow=1&stdout=1 HTTP/1.1\r\nHost: docker\r\n\r\n",
    );
    await vi.waitFor(() => expect(client.received()).toContain("first"));
    const logsSoFar = client.received();

    client.socket.write(upgradeStart(id, '{"Detach":false,"Tty":false}'));
    await settle(200);

    expect(client.received()).not.toContain("HTTP/1.1 101");
    expect(client.received()).toBe(logsSoFar);
    expect(reached(`/exec/${id}/start`)).toEqual([]);
    await resolvesWithin(
      Promise.race([client.ended, client.closed]),
      SETTLE_MS,
      "the connection to close",
    );
    release.resolve();
  });

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
      h.upgradeExchange(upgradeStart(id, body)),
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
  it("forwards an upgrade with 99 headers", async () => {
    const id = await createExec();

    const reply = await h.upgradeExchange(upgradeWith(id, `${fillerHeaders(94)}\r\n`, ""));

    expect(reply).toMatch(/^HTTP\/1\.1 101 /);
    expect(reached(`/exec/${id}/start`)).toHaveLength(1);
  });

  // 100 headers reach the proxy, which refuses them; Node's parser fails the 101st.
  it.each([100, 101])(
    "answers 431 to an upgrade with %i headers, reaching nothing",
    async (count) => {
      const id = await createExec();
      const before = h.daemon.started();

      const reply = await h.rawExchange(upgradeWith(id, `${fillerHeaders(count - 5)}\r\n`, ""));

      expect(reply).toMatch(/^HTTP\/1\.1 431 /);
      expect(h.daemon.started()).toEqual(before);
    },
  );

  it.each([
    [
      "a request",
      `GET /_ping HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n${fillerHeaders(99)}\r\n\r\n`,
    ],
    ["an upgrade", upgradeWith("e".repeat(64), `${fillerHeaders(96)}\r\n`, "")],
  ])("logs %s with 101 headers once, as the parser refused it", async (_label, request) => {
    log.info.mockClear();

    await h.rawExchange(request);

    expect(log.info.mock.calls).toEqual([
      [
        { taskId: TASK_ID, rejection: { kind: "headers_too_large", limit: 100 } },
        "proxy request rejected",
      ],
    ]);
  });

  it("answers 431 to an upgrade whose one header passes 16 KiB, logging it and reaching nothing", async () => {
    const id = await createExec();
    const before = h.daemon.started();
    log.info.mockClear();

    const reply = await h.rawExchange(upgradeWith(id, `X-Big: ${"x".repeat(16 * 1024)}\r\n`, ""));

    expect(reply).toMatch(/^HTTP\/1\.1 431 /);
    expect(reply).toContain("request headers must number fewer than 100 and fit in 16 KiB");
    expect(log.info).toHaveBeenCalledWith(
      { taskId: TASK_ID, rejection: { kind: "headers_too_large", limit: 100 } },
      "proxy request rejected",
    );
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

  it.each([
    ["400 to a chunked body", "Transfer-Encoding: chunked", "0\r\n\r\n", 400],
    ["417 to Expect", "Expect: 100-continue\r\nContent-Length: 0", "", 417],
  ])(
    "answers %s on an unlisted route before classifying it, with no lookup",
    async (_label, framing, body, status) => {
      const client = await halfOpenClient();

      client.socket.write(
        "POST /containers/cogmo-task-own/update HTTP/1.1\r\nHost: docker\r\n" +
          `Connection: Upgrade\r\nUpgrade: tcp\r\n${framing}\r\n\r\n${body}`,
      );

      await expectReleasedAfter(client, rawAnswer(status));
      expect(h.daemon.started()).toEqual([]);
      expect(h.rows.forTask).not.toHaveBeenCalled();
    },
  );

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

    // The client stops writing with its body ten bytes short. Node's HTTP
    // server, still parsing the body, ends the connection on the client's
    // end, so no answer can follow it.
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

  it("rejects an upgrade whose body the client cuts short during the checks, forwarding nothing", async () => {
    const release = Promise.withResolvers<void>();
    h.rows.forTask.mockImplementation(() =>
      ResultAsync.fromSafePromise(release.promise.then(() => TASK_ROWS)),
    );
    log.info.mockClear();
    const client = await halfOpenClient();
    client.socket.write(
      "POST /containers/cogmo-task-own/attach?stream=1 HTTP/1.1\r\nHost: docker\r\n" +
        "Connection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\n" +
        "Content-Length: 100\r\n\r\n0123456789",
    );
    await vi.waitFor(() => expect(h.rows.forTask).toHaveBeenCalled());

    // The client stops ten bytes into a 100-byte body while the store read is held.
    client.socket.end();
    await resolvesWithin(client.ended, SETTLE_MS, "the connection to close");
    release.resolve();

    await vi.waitFor(() =>
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/containers/cogmo-task-own/attach",
          rejection: expect.objectContaining({ kind: "malformed" }),
        }),
        "proxy request rejected",
      ),
    );
    expect(reached("/attach")).toEqual([]);
  });

  it("answers 403 to an upgrade on an unlisted route, contacting the daemon not at all", async () => {
    const path = "/containers/cogmo-task-own/update";
    log.info.mockClear();

    const reply = await h.rawExchange(upgradeRequest("POST", path));

    expect(reply).toMatch(/^HTTP\/1\.1 403 /);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        path,
        rejection: expect.objectContaining({ kind: "denied" }),
      }),
      "proxy request rejected",
    );
    expect(h.daemon.started()).toEqual([]);
  });

  it("sends a refused upgrade's body once, and the bytes after it no further", async () => {
    const id = await createExec();
    const before = h.daemon.requests().length;
    h.daemon.holdUpgrades();
    const client = await rawClient();
    const closed = new Promise<void>((resolve) => client.socket.once("close", () => resolve()));
    const body = '{"Detach":true}';
    client.socket.write(`${upgradeWith(id, "", body)}OPAQUE-MARKER-BYTES`);
    await vi.waitFor(() => expect(h.daemon.upgrades()).toHaveLength(1));
    await settle(100);
    expect(h.daemon.upgrades()).toMatchObject([{ answer: "held", received: "" }]);

    h.daemon.releaseUpgrades();

    await resolvesWithin(closed, SETTLE_MS, "the connection to close");
    expect(client.received()).toMatch(/^HTTP\/1\.1 200 /);
    await vi.waitFor(() =>
      expect(h.daemon.upgrades()).toMatchObject([{ answer: "refused", closed: true }]),
    );
    expect(h.daemon.upgrades()).toMatchObject([{ received: "" }]);
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

describe("the protocol an upgrade names", () => {
  const ATTACH = "/containers/cogmo-task-own/attach?stream=1";
  const ATTACH_WS = "/containers/cogmo-task-own/attach/ws?stream=1";

  it.each(["websocket", "h2c", "tcp, websocket", "tcp/1"])(
    "answers 403 to an exec start that asks for %j, reaching nothing",
    async (protocol) => {
      const id = await createExec();
      const before = h.daemon.started();
      log.info.mockClear();

      const reply = await h.upgradeExchange(
        upgradeRequestWith("POST", `/exec/${id}/start`, protocol),
      );

      expect(reply).toMatch(/^HTTP\/1\.1 403 /);
      expect(reply).toContain("an upgrade of POST /exec/{id}/start to anything but tcp");
      expect(h.daemon.started()).toEqual(before);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({
          path: `/exec/${id}/start`,
          rejection: expect.objectContaining({ kind: "denied" }),
        }),
        "proxy request rejected",
      );
    },
  );

  it.each([
    ["an attach", "websocket", "POST", ATTACH, "POST /containers/{id}/attach to anything but tcp"],
    [
      "a websocket attach",
      "tcp",
      "GET",
      ATTACH_WS,
      "GET /containers/{id}/attach/ws to anything but websocket",
    ],
  ])(
    "answers 403 to %s that asks for %s, before any lookup",
    async (_label, protocol, method, path, refused) => {
      const reply = await h.upgradeExchange(upgradeRequestWith(method, path, protocol));

      expect(reply).toMatch(/^HTTP\/1\.1 403 /);
      expect(reply).toContain(refused);
      expect(h.daemon.started()).toEqual([]);
      expect(h.rows.forTask).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["an attach", "POST", ATTACH, "TCP"],
    ["a websocket attach", "GET", ATTACH_WS, "WebSocket"],
  ])("forwards %s that names its protocol as %s", async (_label, method, path, protocol) => {
    const reply = await h.upgradeExchange(upgradeRequestWith(method, path, protocol));

    expect(reply).toMatch(/^HTTP\/1\.1 101 /);
    expect(h.daemon.upgrades()).toMatchObject([{ answer: "switched" }]);
  });

  it("forwards the Docker CLI 29.9.3's recorded exec start and attach", async () => {
    const id = await createExec();

    const started = await h.upgradeExchange(dockerCliExecStart(id));
    const attached = await h.upgradeExchange(dockerCliAttach("cogmo-task-own"));

    expect(started).toMatch(/^HTTP\/1\.1 101 /);
    expect(attached).toMatch(/^HTTP\/1\.1 101 /);
    expect(h.daemon.upgrades()).toMatchObject([
      { url: `/v1.56/exec/${id}/start`, answer: "switched" },
      {
        url: `/v1.56/containers/${OWN.id}/attach?stderr=1&stdin=1&stdout=1&stream=1`,
        answer: "switched",
      },
    ]);
  });

  it("answers 403, not 404, to an exec start the socket did not create that asks for websocket", async () => {
    const reply = await h.upgradeExchange(
      upgradeRequestWith("POST", `/exec/${"e".repeat(64)}/start`, "websocket"),
    );

    expect(reply).toMatch(/^HTTP\/1\.1 403 /);
    expect(h.daemon.started()).toEqual([]);
  });

  it("forwards an exec start that names tcp in another case", async () => {
    const id = await createExec();

    const reply = await h.upgradeExchange(upgradeRequestWith("POST", `/exec/${id}/start`, "TCP"));

    expect(reply).toMatch(/^HTTP\/1\.1 101 /);
  });
});

describe("a chunked upgrade body", () => {
  const BODY = '{"Detach":false,"Tty":false}';
  const CHUNKED = `${BODY.length.toString(16)}\r\n${BODY}\r\n0\r\n\r\n`;

  it.each([
    ["an exec start", "POST", async () => `/exec/${await createExec()}/start`],
    ["an attach", "POST", async () => "/containers/cogmo-task-own/attach?stream=1"],
  ])("answers 400 to %s, reaching nothing", async (_label, method, target) => {
    const path = await target();
    const before = h.daemon.started();
    const client = await halfOpenClient();

    client.socket.write(
      `${method} ${path} HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n` +
        `Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${CHUNKED}`,
    );

    await expectReleasedAfter(client, rawAnswer(400));
    expect(client.received()).toContain("an upgrade's body must be framed by its Content-Length");
    expect(h.daemon.started()).toEqual(before);
  });
});

describe("the bytes after an upgrade's body", () => {
  const BODY = '{"Detach":false,"Tty":false}';

  it("reach the daemon only once it has answered 101", async () => {
    const id = await createExec();
    h.daemon.holdUpgrades();
    const client = await halfOpenClient();
    client.socket.write(`${upgradeStart(id, BODY)}EARLY`);
    await vi.waitFor(() => expect(h.daemon.upgrades()).toHaveLength(1));
    client.socket.write("LATER");
    await settle(200);
    expect(h.daemon.upgrades()).toMatchObject([{ answer: "held", received: "" }]);

    h.daemon.releaseUpgrades();

    await vi.waitFor(() => expect(client.received()).toMatch(/^HTTP\/1\.1 101 /));
    client.socket.end();
    await resolvesWithin(client.closed, SETTLE_MS, "the stream to end");
    expect(h.daemon.upgrades()).toMatchObject([{ answer: "switched", received: "EARLYLATER" }]);
    expect(client.received()).toMatch(/\r\n\r\nlate-output\n$/);
  });

  it.each([
    ["a detached start", '{"Detach":true}', 200],
    ["a start whose body the daemon rejects", '{"Detach":', 400],
  ])(
    "never reach a daemon that ignores close after %s, and both connections end",
    async (_label, body, status) => {
      const id = await createExec();
      h.daemon.ignoreConnectionClose();
      const client = await halfOpenClient();

      client.socket.write(`${upgradeStart(id, body)}${PRIVILEGED_CREATE}`);

      await expectReleasedAfter(
        client,
        new RegExp(`^HTTP/1\\.1 ${status} [\\s\\S]*\\r\\n\\r\\n\\{.*\\}$`),
      );
      await vi.waitFor(() =>
        expect(h.daemon.upgrades()).toMatchObject([{ answer: "refused", closed: true }]),
      );
      expect(reached("/containers/create")).toEqual([]);
    },
  );

  it("sent while the daemon holds its answer never reach it after a refusal, close ignored", async () => {
    const id = await createExec();
    h.daemon.ignoreConnectionClose();
    h.daemon.holdUpgrades();
    const client = await halfOpenClient();
    client.socket.write(upgradeStart(id, '{"Detach":true}'));
    await vi.waitFor(() => expect(h.daemon.upgrades()).toHaveLength(1));
    client.socket.write(PRIVILEGED_CREATE);
    await settle(200);
    expect(h.daemon.upgrades()).toMatchObject([{ answer: "held", received: "" }]);

    h.daemon.releaseUpgrades();

    await expectReleasedAfter(client, /^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\n\{\}$/);
    await vi.waitFor(() =>
      expect(h.daemon.upgrades()).toMatchObject([{ answer: "refused", closed: true }]),
    );
    expect(h.daemon.upgrades()).toMatchObject([{ received: "" }]);
    expect(reached("/containers/create")).toEqual([]);
  });

  it("are dropped with the daemon request, unlogged, when the client resets while they are held", async () => {
    const id = await createExec();
    h.daemon.holdUpgrades();
    // A paused client reads nothing, so closing it with the ping's answer
    // unread resets the proxy's side of the connection.
    const client = net.createConnection({ path: h.socket });
    client.on("error", () => {});
    client.pause();
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write("GET /_ping HTTP/1.1\r\nHost: docker\r\n\r\n");
    await vi.waitFor(() => expect(reached("/_ping")).toHaveLength(1));
    await settle(100);
    client.write(`${upgradeStart(id, BODY)}HELD`);
    await vi.waitFor(() => expect(h.daemon.upgrades()).toHaveLength(1));
    log.warn.mockClear();
    log.info.mockClear();

    client.destroy();

    await vi.waitFor(() =>
      expect(h.daemon.upgrades()).toMatchObject([{ answer: "held", received: "", closed: true }]),
    );
    await settle(100);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("are not ended by a client that ends its side while they are held, which still gets the answer", async () => {
    const id = await createExec();
    h.daemon.holdUpgrades();
    const client = await halfOpenClient();
    client.socket.write(`${upgradeStart(id, BODY)}HELD`);
    await vi.waitFor(() => expect(h.daemon.upgrades()).toHaveLength(1));

    client.socket.end();
    await settle(200);
    expect(h.daemon.upgrades()).toMatchObject([{ answer: "held", received: "", closed: false }]);
    h.daemon.releaseUpgrades();

    await resolvesWithin(client.closed, SETTLE_MS, "the stream to end");
    expect(client.received()).toMatch(/^HTTP\/1\.1 101 [\s\S]*\r\n\r\nlate-output\n$/);
    expect(h.daemon.upgrades()).toMatchObject([{ answer: "switched", received: "HELD" }]);
  });
});

describe("a daemon refusal the proxy relays", () => {
  /** Replace the fake daemon with one that answers every upgrade `answer` and ends. */
  async function answeringWith(answer: Buffer | string): Promise<() => Promise<void>> {
    await h.daemon.close();
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end(answer));
    });
    await new Promise<void>((resolve) => server.listen(h.daemon.socketPath, resolve));
    return () => new Promise<void>((resolve) => server.close(() => resolve()));
  }

  it("is framed by its length and closes, without the daemon's hop-by-hop headers", async () => {
    const id = await createExec();
    const close = await answeringWith(
      "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nConnection: close\r\n" +
        'Transfer-Encoding: chunked\r\n\r\n10\r\n{"message":"gone\r\n2\r\n"}\r\n0\r\n\r\n',
    );
    try {
      const reply = await resolvesWithin(
        h.rawExchange(upgradeRequest("POST", `/exec/${id}/start`)),
        SETTLE_MS,
        "the proxy to answer",
      );

      expect(reply).toBe(
        "HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: 18\r\n" +
          "connection: close\r\n\r\n" +
          '{"message":"gone"}',
      );
    } finally {
      await close();
    }
  });

  it("relays a refusal with no framing, read to the daemon's close", async () => {
    const id = await createExec();
    const close = await answeringWith("HTTP/1.1 400 Bad Request\r\n\r\nnot websocket protocol");
    try {
      const reply = await resolvesWithin(
        h.rawExchange(upgradeRequest("POST", `/exec/${id}/start`)),
        SETTLE_MS,
        "the proxy to answer",
      );

      expect(reply).toBe(
        "HTTP/1.1 400 Bad Request\r\ncontent-length: 22\r\nconnection: close\r\n\r\n" +
          "not websocket protocol",
      );
    } finally {
      await close();
    }
  });

  it.each([
    ["204 No Content", ""],
    ["304 Not Modified", "Content-Length: 42\r\n"],
  ])("relays a %s with no content-length", async (status, framing) => {
    const id = await createExec();
    const close = await answeringWith(`HTTP/1.1 ${status}\r\nApi-Version: 1.56\r\n${framing}\r\n`);
    try {
      const reply = await resolvesWithin(
        h.rawExchange(upgradeRequest("POST", `/exec/${id}/start`)),
        SETTLE_MS,
        "the proxy to answer",
      );

      expect(reply).toBe(`HTTP/1.1 ${status}\r\napi-version: 1.56\r\nconnection: close\r\n\r\n`);
    } finally {
      await close();
    }
  });

  it("relays a refusal of exactly 16 MiB", async () => {
    const id = await createExec();
    const size = 16 * 1024 * 1024;
    const close = await answeringWith(
      Buffer.concat([
        Buffer.from(`HTTP/1.1 404 Not Found\r\nContent-Length: ${size}\r\n\r\n`),
        Buffer.alloc(size, "x"),
      ]),
    );
    try {
      const reply = await resolvesWithin(
        h.rawExchange(upgradeRequest("POST", `/exec/${id}/start`)),
        SETTLE_MS,
        "the proxy to answer",
      );

      const head = `HTTP/1.1 404 Not Found\r\ncontent-length: ${size}\r\nconnection: close\r\n\r\n`;
      expect(reply.slice(0, head.length)).toBe(head);
      expect(reply.length).toBe(head.length + size);
    } finally {
      await close();
    }
  });

  it.each([
    [
      "whose body ends early",
      'HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"message":',
    ],
    [
      "one byte past 16 MiB",
      Buffer.concat([
        Buffer.from(`HTTP/1.1 404 Not Found\r\nContent-Length: ${16 * 1024 * 1024 + 1}\r\n\r\n`),
        Buffer.alloc(16 * 1024 * 1024 + 1, "x"),
      ]),
    ],
    ["that is not HTTP", "garbage\r\n\r\n"],
    ["whose head the daemon cuts short", "HTTP/1.1 404 Not Found\r\nContent-Ty"],
  ])("answers 502 in place of a refusal %s, logging it", async (_label, answer) => {
    const id = await createExec();
    const close = await answeringWith(answer);
    log.info.mockClear();
    try {
      const reply = await resolvesWithin(
        h.rawExchange(upgradeRequest("POST", `/exec/${id}/start`)),
        SETTLE_MS,
        "the proxy to answer",
      );

      expect(reply).toMatch(rawAnswer(502));
      expect(log.info).toHaveBeenCalledWith(
        {
          taskId: TASK_ID,
          path: `/exec/${id}/start`,
          rejection: expect.objectContaining({ kind: "daemon_failed" }),
        },
        "proxy request rejected",
      );
    } finally {
      await close();
    }
  });
});

describe("a switched upgrade", () => {
  const BODY = '{"Detach":false,"Tty":false}';

  it("delivers the daemon's output after the client ends its side", async () => {
    const id = await createExec();
    const client = await halfOpenClient();
    client.socket.write(upgradeStart(id, BODY));
    await vi.waitFor(() => expect(client.received()).toMatch(/^HTTP\/1\.1 101 /));

    client.socket.end("stdin\n");

    await resolvesWithin(client.closed, SETTLE_MS, "the stream to end");
    expect(client.received()).toMatch(/\r\n\r\nlate-output\n$/);
    expect(h.daemon.upgrades().map((u) => u.received)).toEqual(["stdin\n"]);
  });

  it("forwards an upgrade whose client ends its side with the last of the body", async () => {
    const id = await createExec();
    const client = await halfOpenClient();
    const request = upgradeStart(id, BODY);
    client.socket.write(request.slice(0, -5));
    await settle(100);

    client.socket.end(request.slice(-5));

    await resolvesWithin(client.closed, SETTLE_MS, "the stream to end");
    expect(client.received()).toMatch(/^HTTP\/1\.1 101 [\s\S]*\r\n\r\nlate-output\n$/);
    const start = expectDefined(
      h.daemon.requests().find((r) => r.url === `/exec/${id}/start`),
      "the upgrade",
    );
    expect(start.body).toBe(BODY);
  });

  it("sends the bytes before and after the switch once each, in order, after the body", async () => {
    const id = await createExec();
    const client = await halfOpenClient();

    client.socket.write(`${upgradeStart(id, BODY)}MARKER-ONE`);
    await vi.waitFor(() => expect(client.received()).toMatch(/^HTTP\/1\.1 101 /));
    client.socket.end("MARKER-TWO");
    await resolvesWithin(client.closed, SETTLE_MS, "the stream to end");

    const start = expectDefined(
      h.daemon.requests().find((r) => r.url === `/exec/${id}/start`),
      "the upgrade",
    );
    expect(start.body).toBe(BODY);
    expect(h.daemon.upgrades()).toMatchObject([
      { url: `/exec/${id}/start`, answer: "switched", received: "MARKER-ONEMARKER-TWO" },
    ]);
  });

  it("sends a body split across writes, and the bytes after it, once each and in order", async () => {
    const id = await createExec();
    const client = await halfOpenClient();
    const request = upgradeStart(id, BODY);
    client.socket.write(request.slice(0, -10));
    await settle(100);

    client.socket.write(`${request.slice(-10)}MARKER-ONE`);
    await vi.waitFor(() => expect(client.received()).toMatch(/^HTTP\/1\.1 101 /));
    client.socket.end("MARKER-TWO");
    await resolvesWithin(client.closed, SETTLE_MS, "the stream to end");

    const start = expectDefined(
      h.daemon.requests().find((r) => r.url === `/exec/${id}/start`),
      "the upgrade",
    );
    expect(start.body).toBe(BODY);
    expect(h.daemon.upgrades()).toMatchObject([
      { url: `/exec/${id}/start`, answer: "switched", received: "MARKER-ONEMARKER-TWO" },
    ]);
  });

  it("relays the stream bytes the daemon sends with its 101, then the rest, in order", async () => {
    const id = await createExec();
    h.daemon.leadUpgrades("LEAD-BYTES");

    const reply = await h.upgradeExchange(upgradeStart(id, BODY));

    expect(reply).toBe(
      "HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nLEAD-BYTESlate-output\n",
    );
  });

  it("delivers a stream the daemon ends first, then releases a client still writing", async () => {
    const id = await createExec();
    h.daemon.finishUpgrades("final-output\n");
    const client = await halfOpenClient();

    client.socket.write(upgradeStart(id, BODY));

    await expectReleasedAfter(client, /^HTTP\/1\.1 101 [\s\S]*\r\n\r\nfinal-output\n$/);
  });

  it("drops the hop-by-hop headers and those Connection names from the preamble, keeping Upgrade", async () => {
    const id = await createExec();

    await h.upgradeExchange(
      [
        `POST /exec/${id}/start HTTP/1.1`,
        "Host: docker",
        "Connection: Upgrade, X-Hop-Secret",
        "Upgrade: tcp",
        "X-Hop-Secret: 1",
        "Keep-Alive: timeout=5",
        "Proxy-Connection: keep-alive",
        "TE: trailers",
        "Trailer: X-Sum",
        "X-Kept: 1",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"),
    );

    const start = expectDefined(
      h.daemon.requests().find((r) => r.url === `/exec/${id}/start`),
      "the upgrade",
    );
    // Node frames the empty body of a POST.
    expect(start.headers).toEqual({
      host: "docker",
      upgrade: "tcp",
      "x-kept": "1",
      connection: "Upgrade, close",
      "content-length": "0",
    });
  });

  it("forwards a header octet outside ASCII as itself", async () => {
    const id = await createExec();

    await h.upgradeExchange(Buffer.from(upgradeWith(id, "X-Ext: caf\xe9\r\n", ""), "latin1"));

    const start = expectDefined(
      h.daemon.requests().find((r) => r.url === `/exec/${id}/start`),
      "the upgrade",
    );
    expect(start.headers["x-ext"]).toBe("caf\xe9");
  });
});

describe("a raw answer to a client that keeps its side open", () => {
  const UNKNOWN_EXEC = "e".repeat(64);

  it("releases the connection after an upgrade's rejection", async () => {
    const client = await halfOpenClient();

    client.socket.write(upgradeRequest("POST", `/exec/${UNKNOWN_EXEC}/start`));

    await expectReleasedAfter(client, rawAnswer(404));
  });

  it("releases the connection after a rejection while the body is still arriving", async () => {
    const client = await halfOpenClient();

    client.socket.write(
      `POST /exec/${UNKNOWN_EXEC}/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\n` +
        "Upgrade: tcp\r\nContent-Length: 10\r\n\r\n",
    );

    await expectReleasedAfter(client, rawAnswer(404));
  });

  it("releases the connection after the parser's 431", async () => {
    const client = await halfOpenClient();

    client.socket.write(`GET /_ping HTTP/1.1\r\nHost: docker\r\n${fillerHeaders(100)}\r\n\r\n`);

    await expectReleasedAfter(client, rawAnswer(431));
  });

  it("releases the connection after an upgrade's 502", async () => {
    const id = await createExec();
    await h.daemon.close();
    const client = await halfOpenClient();

    client.socket.write(upgradeRequest("POST", `/exec/${id}/start`));

    await expectReleasedAfter(client, rawAnswer(502));
  });

  it("releases the connection after the daemon refuses an upgrade and closes its own", async () => {
    const id = await createExec();
    const client = await halfOpenClient();

    client.socket.write(upgradeStart(id, '{"Detach":true}'));

    await expectReleasedAfter(client, /^HTTP\/1\.1 200 [\s\S]*\r\n\r\n\{\}$/);
    await vi.waitFor(() =>
      expect(h.daemon.upgrades()).toMatchObject([{ answer: "refused", closed: true }]),
    );
  });
});

describe("a parser error behind a request still being answered", () => {
  it.each([
    ["101 headers", fillerHeaders(100)],
    ["a header past 16 KiB", `X-Big: ${"x".repeat(16 * 1024)}`],
  ])("closes the connection rather than answer ahead of it, for %s", async (_label, headers) => {
    const release = Promise.withResolvers<void>();
    h.daemon.setResponder((req, res, raw) => {
      if (req.url !== "/_ping") return API(req, res, raw);
      release.promise.then(() => API(req, res, raw));
    });
    const client = await halfOpenClient();
    client.socket.write("GET /_ping HTTP/1.1\r\nHost: docker\r\n\r\n");
    await vi.waitFor(() => expect(reached("/_ping")).toEqual(["GET /_ping"]));

    client.socket.write(`GET /_ping HTTP/1.1\r\nHost: docker\r\n${headers}\r\n\r\n`);

    // Bytes the proxy left unread make its close a reset rather than an end.
    await resolvesWithin(
      Promise.race([client.ended, client.closed]),
      SETTLE_MS,
      "the connection to close",
    );
    expect(client.received()).toBe("");
    release.resolve();
    client.socket.destroy();
  });
});

describe("a task's signal", () => {
  // Node sets no listener bound on an `AbortSignal`, and every connection and
  // daemon request of a task listens on its one signal.
  it("takes 20 concurrent requests without a listener-leak warning", async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on("warning", onWarning);
    const release = Promise.withResolvers<void>();
    h.daemon.setResponder((req, res, raw) => {
      if (req.url !== "/_ping") return API(req, res, raw);
      release.promise.then(() => API(req, res, raw));
    });
    try {
      const pings = Array.from({ length: 20 }, () => h.send("GET", "/_ping"));
      await vi.waitFor(() => expect(reached("/_ping")).toHaveLength(20));
      release.resolve();

      const answers = await Promise.all(pings);

      expect(answers.map((r) => r.status)).toEqual(Array.from({ length: 20 }, () => 200));
      await settle(50);
      expect(warnings.filter((w) => w.name === "MaxListenersExceededWarning")).toEqual([]);
    } finally {
      process.off("warning", onWarning);
    }
  });
});

describe("a task socket torn down under an upgrade", () => {
  it.each([
    ["before the daemon answers", true, ""],
    [
      "after the daemon's 101",
      false,
      "HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
    ],
  ])(
    "closes both connections of a live upgrade %s, appending nothing",
    async (_label, hold, answered) => {
      const id = await createExec();
      if (hold) h.daemon.holdUpgrades();
      const client = await halfOpenClient();
      client.socket.write(upgradeStart(id, '{"Detach":false,"Tty":false}'));
      await vi.waitFor(() => expect(h.daemon.upgrades()).toHaveLength(1));
      await vi.waitFor(() => expect(client.received()).toBe(answered));

      await resolvesWithin(h.proxy.unregisterTask(TASK_ID), SETTLE_MS, "the teardown to finish");

      await resolvesWithin(client.ended, SETTLE_MS, "the client connection to close");
      await vi.waitFor(() => expect(h.daemon.upgrades()).toMatchObject([{ closed: true }]));
      await settle(100);
      expect(client.received()).toBe(answered);
      client.socket.destroy();
    },
  );

  it("closes an upgrade whose body is still arriving", async () => {
    const id = await createExec();
    const client = await halfOpenClient();
    client.socket.write(
      `POST /exec/${id}/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\n` +
        'Upgrade: tcp\r\nContent-Length: 10\r\n\r\n{"a"',
    );
    await settle(100);

    await resolvesWithin(h.proxy.unregisterTask(TASK_ID), SETTLE_MS, "the teardown to finish");
    client.socket.write("after the teardown");

    await resolvesWithin(client.closed, SETTLE_MS, "the client to see the close");
    expect(reached(`/exec/${id}/start`)).toEqual([]);
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
  ])("answers 403 to an upgrade on %s %s, which is not a stream route", async (method, path) => {
    const reply = await h.rawExchange(upgradeRequest(method, path));

    expect(reply).toMatch(/^HTTP\/1\.1 403 /);
    expect(reply).toContain("upgrading a request other than exec start or attach");
    expect(h.received()).toEqual([]);
  });

  it("answers a teardown during a container list read whole once, logging no error", async () => {
    h.daemon.setResponder((req, res, raw) => {
      if (!req.url.startsWith("/containers/json")) return API(req, res, raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.write('[{"Id":');
    });
    log.error.mockClear();
    const client = await halfOpenClient();
    client.socket.write("GET /containers/json HTTP/1.1\r\nHost: docker\r\n\r\n");
    await vi.waitFor(() => expect(reached("/containers/json")).toHaveLength(1));
    await settle(100);

    await resolvesWithin(h.proxy.unregisterTask(TASK_ID), SETTLE_MS, "the teardown to finish");
    await settle(100);

    expect(log.error).not.toHaveBeenCalled();
    expect(client.received().match(/HTTP\/1\.1 \d{3} /g) ?? []).not.toHaveLength(2);
    client.socket.destroy();
  });

  it("ends and releases a client's connection when the daemon cuts a relayed stream short", async () => {
    h.daemon.setResponder((req, res, raw) => {
      if (!req.url.startsWith("/distribution/")) return API(req, res, raw);
      res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      res.write('{"Descriptor":', () => res.destroy());
    });
    const client = await halfOpenClient();

    client.socket.write("GET /distribution/alpine/json HTTP/1.1\r\nHost: docker\r\n\r\n");

    await resolvesWithin(client.ended, SETTLE_MS, "the proxy to end the connection");
    await expectReleasedAfter(client, /^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\n\{"Descriptor":$/);
  });

  it("answers 502 to a forwarded stream whose daemon connection fails", async () => {
    await h.daemon.close();

    const r = await h.send("GET", "/distribution/alpine/json");

    expect(r.status, r.body).toBe(502);
  });

  it("answers 502 to an upgrade whose daemon connection fails, logging it", async () => {
    const id = await createExec();
    await h.daemon.close();
    log.info.mockClear();

    const reply = await h.rawExchange(upgradeRequest("POST", `/exec/${id}/start`));

    expect(reply).toMatch(/^HTTP\/1\.1 502 /);
    expect(log.info).toHaveBeenCalledWith(
      {
        taskId: TASK_ID,
        path: `/exec/${id}/start`,
        rejection: expect.objectContaining({ kind: "daemon_failed" }),
      },
      "proxy request rejected",
    );
  });

  it("answers 502 to an upgrade whose daemon connection closes cleanly before its first byte", async () => {
    const id = await createExec();
    await h.daemon.close();
    // Reads what it is sent, so its end is a clean one rather than a reset.
    const closer = net.createServer((socket) => {
      socket.resume();
      socket.once("data", () => socket.end());
    });
    await new Promise<void>((resolve) => closer.listen(h.daemon.socketPath, resolve));
    try {
      const reply = await resolvesWithin(
        h.rawExchange(upgradeRequest("POST", `/exec/${id}/start`)),
        SETTLE_MS,
        "the proxy to answer",
      );

      expect(reply).toMatch(/^HTTP\/1\.1 502 /);
      expect(reply).toContain("Cogmo proxy upstream error: socket hang up");
    } finally {
      await new Promise<void>((resolve) => closer.close(() => resolve()));
    }
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
