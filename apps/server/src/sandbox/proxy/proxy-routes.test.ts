import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { expectDefined } from "../../test/assertions.js";
import { BRIDGE_NETWORK, respondJson } from "../../test/fake-docker-daemon.js";
import {
  API,
  CHILD,
  CHILD_ROW,
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
  useProxyHarness,
} from "../../test/proxy-harness.js";
import { TESTCONTAINERS_PULL_REQUEST } from "../../test/testcontainers-requests.js";

const ListSchema = z.array(z.looseObject({ Id: z.string() }));

/** Header lines enough to reach the server's count, and past Node's default of 2000. */
const MANY_HEADERS = Array.from({ length: 2000 }, () => "a: 1").join("\r\n");

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

  it("answers 431 to a request past the header count, a body after it reaching nothing", async () => {
    const reply = await h.rawExchange(
      `GET /_ping HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n${MANY_HEADERS}\r\n` +
        "Content-Length: 5\r\n\r\nhello",
    );

    expect(reply).toMatch(/^HTTP\/1\.1 431 /);
    expect(h.daemon.started()).toEqual([]);
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
      res.write("[", () => res.destroy());
    });

    const r = await h.send("GET", "/containers/json");

    expect(r.status, r.body).toBe(502);
    expect(message(r)).toContain("ended early");
  });

  it("forwards a list's filters as they came and keeps only owned containers", async () => {
    const r = await h.send("GET", "/containers/json?filters=%7B%7D");

    expect(r.status, r.body).toBe(200);
    expect(h.received()).toEqual(["GET /containers/json?filters=%7B%7D"]);
    expect(ListSchema.parse(JSON.parse(r.body)).map((c) => c.Id)).toEqual([
      OWN.id,
      CHILD.id,
      RECORDED.id,
    ]);
  });

  it("answers unavailable to a list while the task's own row is missing", async () => {
    h.rows.forTask.mockReturnValue(okAsync([SALVAGE_ROW, CHILD_ROW]));

    h.expectRejected(await h.send("GET", "/containers/json"), 503, []);
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
  const PRIVILEGED = JSON.stringify({ Image: "alpine:3", HostConfig: { Privileged: true } });
  const SMUGGLED =
    "POST /containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n" +
    `Content-Length: ${Buffer.byteLength(PRIVILEGED)}\r\n\r\n${PRIVILEGED}`;

  it("keeps a body's Content-Length that Connection names, so the body is not a second request", async () => {
    await h.rawExchange(
      [
        "GET /_ping HTTP/1.1",
        "Host: docker",
        "Connection: close, content-length",
        `Content-Length: ${Buffer.byteLength(SMUGGLED)}`,
        "",
        SMUGGLED,
      ].join("\r\n"),
    );

    expect(h.daemon.started()).toEqual(["GET /_ping"]);
    expect(expectDefined(h.daemon.requests()[0], "ping").body).toBe(SMUGGLED);
  });

  it("forwards a body whose Content-Length Connection names as one request carrying it", async () => {
    await h.rawExchange(
      [
        "GET /containers/own-child/json HTTP/1.1",
        "Host: docker",
        "Connection: close, Content-Length",
        "Content-Length: 5",
        "",
        "hello",
      ].join("\r\n"),
    );

    expect(h.daemon.started()).toEqual([
      resolveOf("own-child"),
      `GET /containers/${CHILD.id}/json`,
    ]);
    expect(expectDefined(h.daemon.requests()[1], "inspect").body).toBe("hello");
  });

  it("drops the headers a request's Connection names, and Proxy-Connection", async () => {
    await h.rawExchange(
      [
        "GET /_ping HTTP/1.1",
        "Host: docker",
        "Connection: close, X-Hop-Secret",
        "X-Hop-Secret: 1",
        "Proxy-Connection: keep-alive",
        "X-Kept: 1",
        "",
        "",
      ].join("\r\n"),
    );

    const seen = expectDefined(h.daemon.requests()[0], "ping").headers;
    expect(seen["x-hop-secret"]).toBeUndefined();
    expect(seen["proxy-connection"]).toBeUndefined();
    expect(seen["x-kept"]).toBe("1");
  });

  it("drops the headers a response's Connection names, and Proxy-Connection", async () => {
    h.daemon.setResponder((req, res, raw) => {
      if (!req.url.startsWith("/info")) return API(req, res, raw);
      res.writeHead(200, {
        "content-type": "application/json",
        connection: "x-daemon-hop",
        "x-daemon-hop": "1",
        "proxy-connection": "keep-alive",
        "x-kept": "1",
      });
      res.end("{}");
    });

    const r = await h.send("GET", "/info");

    expect(r.status, r.body).toBe(200);
    expect(r.headers["x-daemon-hop"]).toBeUndefined();
    expect(r.headers["proxy-connection"]).toBeUndefined();
    expect(r.headers["x-kept"]).toBe("1");
  });

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

describe("image pulls", () => {
  it.each([
    ["an import", "?fromSrc=-&repo=cogmo-devbase&tag=latest"],
    ["a pull that also names repo", "?fromImage=alpine&repo=cogmo-devbase"],
    ["a pull that also names message", "?fromImage=alpine&message=m"],
    ["a pull that also names changes", "?fromImage=alpine&changes=CMD%20sh"],
    ["a pull that also names fromSrc", "?fromImage=alpine&fromSrc=http%3A%2F%2Fhost%2Fx.tar"],
    ["an empty fromSrc", "?fromImage=alpine&fromSrc="],
    ["no fromImage", "?tag=3"],
    ["an empty fromImage", "?fromImage="],
    ["no query", ""],
  ])("denies %s, reaching nothing", async (_label, query) => {
    h.expectRejected(await h.send("POST", `/images/create${query}`), 403, []);
  });

  it("forwards the recorded testcontainers pull with its JSON body dropped", async () => {
    const req = TESTCONTAINERS_PULL_REQUEST;

    const r = await h.send(req.method, req.path, req.body, { ...req.headers });

    expect(r.status, r.body).toBe(200);
    expect(h.received()).toEqual(["POST /images/create?fromImage=busybox&tag=1.36.1"]);
    const pull = expectDefined(h.daemon.requests()[0], "pull");
    expect(pull.body).toBe("");
    expect(pull.headers["content-length"]).toBe("0");
    expect(pull.headers["content-type"]).toBeUndefined();
  });

  it("forwards a pull with a form body carrying fromSrc as a pull of the query's fromImage", async () => {
    const body = "fromImage=&fromSrc=http%3A%2F%2Fhost%2Fevil.tar&repo=cogmo-devbase&tag=latest";

    const r = await h.send("POST", "/images/create?fromImage=alpine", body, {
      "content-type": "application/x-www-form-urlencoded",
    });

    expect(r.status, r.body).toBe(200);
    expect(h.received()).toEqual(["POST /images/create?fromImage=alpine"]);
    expect(expectDefined(h.daemon.requests()[0], "pull").body).toBe("");
  });

  it("forwards a pull with a chunked body as a pull with none", async () => {
    const reply = await h.rawExchange(
      [
        "POST /images/create?fromImage=alpine HTTP/1.1",
        "Host: docker",
        "Transfer-Encoding: chunked",
        "Connection: close",
        "",
        "5\r\nhello",
        "0",
        "",
        "",
      ].join("\r\n"),
    );

    expect(reply).toMatch(/^HTTP\/1\.1 200 /);
    expect(h.received()).toEqual(["POST /images/create?fromImage=alpine"]);
    const pull = expectDefined(h.daemon.requests()[0], "pull");
    expect(pull.body).toBe("");
    expect(pull.headers["transfer-encoding"]).toBeUndefined();
  });

  it("forwards a pull with an empty tag and platform as fromImage alone, with no body", async () => {
    const r = await h.send("POST", "/images/create?fromImage=alpine&tag=&platform=");

    expect(r.status, r.body).toBe(200);
    expect(h.received()).toEqual(["POST /images/create?fromImage=alpine"]);
    const pull = expectDefined(h.daemon.requests()[0], "pull");
    expect(pull.body).toBe("");
    expect(pull.headers["content-length"]).toBe("0");
  });

  it("forwards a pull with only fromImage, tag and platform", async () => {
    const r = await h.send(
      "POST",
      "/v1.44/images/create?fromImage=alpine&tag=3&platform=linux%2Famd64&Image=x&fromImage=other",
    );

    expect(r.status, r.body).toBe(200);
    expect(h.received()).toEqual([
      "POST /v1.44/images/create?fromImage=alpine&tag=3&platform=linux%2Famd64",
    ]);
  });
});
