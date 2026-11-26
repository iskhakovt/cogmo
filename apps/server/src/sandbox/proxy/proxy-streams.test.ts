import * as net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resolvesWithin } from "../../test/assertions.js";
import { API, OWN, upgradeRequest, useProxyHarness } from "../../test/proxy-harness.js";

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

const SIBLING_KILL =
  "POST /containers/cogmo-task-sibling/kill HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\n\r\n";
const PRIVILEGED = JSON.stringify({ Image: "alpine:3", HostConfig: { Privileged: true } });
const PRIVILEGED_CREATE =
  "POST /containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n" +
  `Content-Length: ${Buffer.byteLength(PRIVILEGED)}\r\n\r\n${PRIVILEGED}`;

describe("a request pipelined after a streaming one", () => {
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

describe("streams and relays", () => {
  it.each([
    ["a stats stream", "GET", "stats", true],
    ["a wait the daemon has not answered", "POST", "wait", false],
  ])(
    "closes the daemon request when the client hangs up on %s",
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
    },
  );

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
