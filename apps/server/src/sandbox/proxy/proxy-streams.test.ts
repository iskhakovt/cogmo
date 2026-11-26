import * as net from "node:net";
import { ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { expectDefined, resolvesWithin } from "../../test/assertions.js";
import { respondJson } from "../../test/fake-docker-daemon.js";
import {
  API,
  fillerHeaders,
  OWN,
  TASK_ID,
  TASK_ROWS,
  upgradeRequest,
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
    expect(start.headers).toEqual({
      host: "docker",
      upgrade: "tcp",
      "x-kept": "1",
      connection: "Upgrade, close",
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
  ])("answers 400 to an upgrade on %s %s, which is not a stream route", async (method, path) => {
    const reply = await h.rawExchange(upgradeRequest(method, path));

    expect(reply).toMatch(/^HTTP\/1\.1 400 /);
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

  it("answers 502 to an upgrade whose daemon connection fails", async () => {
    const id = await createExec();
    await h.daemon.close();

    const reply = await h.rawExchange(upgradeRequest("POST", `/exec/${id}/start`));

    expect(reply).toMatch(/^HTTP\/1\.1 502 /);
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
      expect(reply).toContain("the daemon closed the connection before answering");
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
