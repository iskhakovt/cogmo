import * as net from "node:net";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { expectDefined, resolvesWithin } from "../../test/assertions.js";
import { BRIDGE_NETWORK, respondJson } from "../../test/fake-docker-daemon.js";
import {
  API,
  CHILD,
  COGMO_OWN,
  containerId,
  message,
  OWN,
  RECORDED,
  resolveOf,
  SALVAGE,
  SALVAGE_ROW,
  SIBLING,
  SIBLING_TASK_ID,
  TASK_ID,
  upgradeRequest,
  useProxyHarness,
} from "../../test/proxy-harness.js";

const ListSchema = z.array(z.looseObject({ Id: z.string() }));

/** Budget for each wait on a connection; ample headroom over the milliseconds they take. */
const SETTLE_MS = 2_500;

const h = useProxyHarness();

function event(id: string, attributes: Readonly<Record<string, string>>): string {
  return JSON.stringify({
    Type: "container",
    Action: "start",
    Actor: { ID: id, Attributes: attributes },
    scope: "local",
    time: 1,
  });
}

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
    const r = await h.send(method, path);

    expect(r.status, r.body).toBe(200);
    expect(h.received()).toEqual([`${method} ${path}`]);
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
    ["POST", "/containers/cogmo-task-own/checkpoints"],
    ["DELETE", "/containers/cogmo-task-own/checkpoints/cp1"],
    ["GET", "/debug/pprof/heap"],
    ["OPTIONS", "/containers/json"],
    ["GET", "/foo"],
    ["GET", "/containers/cogmo-task-own/nothing"],
    ["GET", "/v1.43/containers/json"],
    ["GET", "/v1.24/_ping"],
    ["POST", "/v1.40/containers/own-child/start"],
    ["GET", "/v1.43/events"],
  ])("denies %s %s without contacting the daemon", async (method, path) => {
    h.expectRejected(await h.send(method, path), 403, []);
  });

  it.each([
    ["a malformed percent-encoding in the path", "/containers/%zz/json"],
    ["a path escape that is not UTF-8", "/images/%FF/json"],
    ["a query escape that is not two hex digits", "/_ping?probe=%zz"],
    ["a query escape cut short", "/_ping?probe=%4"],
  ])("answers 400 to %s, reaching nothing", async (_label, path) => {
    h.expectRejected(await h.send("GET", path), 400, []);
  });

  it.each([
    ["a trailing slash", "/_ping/", "/_ping"],
    ["a backslash", "/images\\json", "/images/json"],
    [
      "an encoded slash in a stream route",
      "/v1.44/distribution/library%2Falpine/json",
      "/v1.44/distribution/library/alpine/json",
    ],
  ])("forwards a path with %s under its canonical form", async (_label, path, forwarded) => {
    const r = await h.send("GET", path);

    expect(r.status, r.body).toBe(200);
    expect(h.received()).toEqual([`GET ${forwarded}`]);
  });
});

describe("lists and events", () => {
  it("keeps only owned containers in GET /containers/json, salvage left out", async () => {
    const r = await h.send("GET", "/containers/json?all=1");

    expect(r.status, r.body).toBe(200);
    expect(ListSchema.parse(JSON.parse(r.body)).map((c) => c.Id)).toEqual([
      OWN.id,
      CHILD.id,
      RECORDED.id,
    ]);
    expect(h.received()).toEqual(["GET /containers/json?all=1"]);
    expect(r.headers["content-length"]).toBe(String(Buffer.byteLength(r.body)));
  });

  it("answers unavailable when the store read for a list fails", async () => {
    h.rows.forTask.mockReturnValue(errAsync({ kind: "store_failed", cause: new Error("db down") }));

    h.expectRejected(await h.send("GET", "/containers/json"), 503, []);
  });

  it("answers unavailable to a container list that is not JSON", async () => {
    h.daemon.setResponder((req, res, raw) => {
      if (req.url.startsWith("/containers/json")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[{");
        return;
      }
      API(req, res, raw);
    });

    const r = await h.send("GET", "/containers/json");

    expect(r.status, r.body).toBe(503);
  });

  it("relays a container list the daemon refused as it is", async () => {
    h.daemon.setResponder((req, res, raw) =>
      req.url.startsWith("/containers/json")
        ? respondJson(res, 400, { message: "invalid filter" })
        : API(req, res, raw),
    );

    const r = await h.send("GET", "/containers/json?filters=x");

    expect(r.status, r.body).toBe(400);
    expect(message(r)).toBe("invalid filter");
  });

  it("answers daemon_failed to a container list the daemon cut short", async () => {
    h.daemon.setResponder((req, res, raw) => {
      if (!req.url.startsWith("/containers/json")) return API(req, res, raw);
      res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      res.write("[");
      res.destroy();
    });

    const r = await h.send("GET", "/containers/json");

    expect(r.status, r.body).toBe(502);
  });

  it("relays an event stream the daemon refused as it is", async () => {
    h.daemon.setResponder((req, res, raw) =>
      req.url.startsWith("/events")
        ? respondJson(res, 400, { message: "invalid filter" })
        : API(req, res, raw),
    );

    const r = await h.send("GET", "/events?filters=x");

    expect(r.status, r.body).toBe(400);
    expect(message(r)).toBe("invalid filter");
  });

  it("drops every GET /events line that is not the task container's or its children's", async () => {
    const own = event(OWN.id, OWN.labels);
    const child = event(CHILD.id, CHILD.labels);
    const lines = [
      own,
      event(SALVAGE.id, SALVAGE.labels),
      child,
      event(SIBLING.id, SIBLING.labels),
      event(containerId("8b"), { "cogmo.root_task": SIBLING_TASK_ID, "cogmo.parent": SIBLING.id }),
      event(COGMO_OWN.id, COGMO_OWN.labels),
      event(containerId("8c"), { "cogmo.root_task": TASK_ID }),
      JSON.stringify({
        Type: "network",
        Actor: { ID: BRIDGE_NETWORK.id, Attributes: { container: OWN.id } },
      }),
      JSON.stringify({ Type: "volume", Actor: { ID: "v1", Attributes: { driver: "local" } } }),
      "not json",
    ];
    h.daemon.setResponder((req, res, raw) => {
      if (!req.url.startsWith("/events")) return API(req, res, raw);
      res.writeHead(200, { "content-type": "application/jsonl" });
      res.end(lines.map((l) => `${l}\n`).join(""));
    });

    const r = await h.send("GET", "/events?since=0&filters=%7B%7D");

    expect(r.status, r.body).toBe(200);
    expect(r.body).toBe(`${own}\n${child}\n`);
    expect(h.received()).toEqual(["GET /events?since=0&filters=%7B%7D"]);
  });

  it("answers unavailable to GET /events while the task's own row is missing", async () => {
    h.rows.forTask.mockReturnValue(okAsync([SALVAGE_ROW]));

    h.expectRejected(await h.send("GET", "/events"), 503, []);
  });

  it("answers daemon_failed to a container list over 16 MiB", async () => {
    h.daemon.setResponder((req, res, raw) => {
      if (!req.url.startsWith("/containers/json")) return API(req, res, raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`["${"x".repeat(16 * 1024 * 1024)}"]`);
    });

    const r = await h.send("GET", "/containers/json");

    expect(r.status, r.body).toBe(502);
    expect(message(r)).toContain("exceeds");
  });
});

describe("hop-by-hop headers", () => {
  it("drops them from a normal forward, a Trailer on a body-less GET included", async () => {
    const reply = await h.rawExchange(
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
    const seen = expectDefined(h.daemon.requests()[0], "ping").headers;
    expect(seen["keep-alive"]).toBeUndefined();
    expect(seen.te).toBeUndefined();
    expect(seen.trailer).toBeUndefined();
    expect(seen.upgrade).toBeUndefined();
  });

  it("re-frames a chunked body so none of it reaches the daemon as a request", async () => {
    const smuggled = "GET /containers/json HTTP/1.1\r\nHost: docker\r\n\r\n";
    const reply = await h.rawExchange(
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

    expect(reply).toMatch(/^HTTP\/1\.1 200 /);
    expect(h.received()).toEqual([resolveOf("own-child"), `GET /containers/${CHILD.id}/json`]);
    expect(expectDefined(h.daemon.requests()[1], "inspect").body).toBe(smuggled);
  });

  it("drops them from the daemon's response, its body complete", async () => {
    h.daemon.setResponder((req, res, raw) => {
      if (!req.url.startsWith("/info")) return API(req, res, raw);
      res.writeHead(200, {
        "content-type": "application/json",
        connection: "keep-alive",
        "keep-alive": "timeout=9",
        te: "trailers",
        trailer: "X-Checksum",
      });
      res.write('{"Name":');
      res.addTrailers({ "X-Checksum": "1" });
      res.end('"host"}');
    });

    const r = await h.send("GET", "/info");

    expect(r.status, r.body).toBe(200);
    expect(r.body).toBe('{"Name":"host"}');
    expect(r.headers["keep-alive"]).toBeUndefined();
    expect(r.headers.te).toBeUndefined();
    expect(r.headers.trailer).toBeUndefined();
    expect(r.headers.connection).toBe("close");
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

  it("answers 502 to a stream route whose daemon connection fails", async () => {
    await h.daemon.close();

    const r = await h.send("GET", "/distribution/alpine/json");

    expect(r.status, r.body).toBe(502);
  });

  it("answers 502 to an upgrade whose daemon connection fails", async () => {
    await h.daemon.close();

    const reply = await h.rawExchange(upgradeRequest("GET", "/distribution/alpine/json"));

    expect(reply).toMatch(/^HTTP\/1\.1 502 /);
  });
});
