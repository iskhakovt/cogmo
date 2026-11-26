import * as net from "node:net";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { requestOverSocket, respondJson } from "../../test/fake-docker-daemon.js";
import {
  API,
  CHILD,
  CHILD_ROW,
  COGMO_OWN,
  message,
  OWN,
  RECORDED,
  resolveOf,
  SALVAGE,
  SALVAGE_ROW,
  SIBLING,
  SIBLING_SCOPE,
  UNKNOWN_ID,
  upgradeRequest,
  useProxyHarness,
} from "../../test/proxy-harness.js";
import {
  TESTCONTAINERS_CONTAINER_REQUESTS,
  TESTCONTAINERS_EXEC_REQUESTS,
} from "../../test/testcontainers-requests.js";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../logger.js", () => ({ logger: { child: () => log } }));

const ExecCreatedSchema = z.object({ Id: z.string() });

const h = useProxyHarness();

describe("container ownership", () => {
  it.each([
    ["GET", "/containers/cogmo-task-own/json", `/containers/${OWN.id}/json`],
    ["GET", "/v1.44/containers/cogmo-task-own/json", `/v1.44/containers/${OWN.id}/json`],
    ["GET", "/containers/cogmo-task-own/top?ps_args=aux", `/containers/${OWN.id}/top?ps_args=aux`],
    [
      "GET",
      "/containers/cogmo-task-own/logs?stdout=true&tail=-1",
      `/containers/${OWN.id}/logs?stdout=true&tail=-1`,
    ],
    [
      "GET",
      "/containers/cogmo-task-own/stats?stream=false",
      `/containers/${OWN.id}/stats?stream=false`,
    ],
    ["GET", "/containers/cogmo-task-own/changes", `/containers/${OWN.id}/changes`],
    ["GET", "/containers/cogmo-task-own/export", `/containers/${OWN.id}/export`],
    [
      "GET",
      "/containers/cogmo-task-own/archive?path=%2Fetc",
      `/containers/${OWN.id}/archive?path=%2Fetc`,
    ],
    [
      "HEAD",
      "/containers/cogmo-task-own/archive?path=%2Fetc",
      `/containers/${OWN.id}/archive?path=%2Fetc`,
    ],
    [
      "POST",
      "/containers/cogmo-task-own/wait?condition=not-running",
      `/containers/${OWN.id}/wait?condition=not-running`,
    ],
    [
      "POST",
      "/containers/cogmo-task-own/resize?h=24&w=80",
      `/containers/${OWN.id}/resize?h=24&w=80`,
    ],
    [
      "POST",
      "/containers/cogmo-task-own/attach?stream=1&stdout=1",
      `/containers/${OWN.id}/attach?stream=1&stdout=1`,
    ],
    [
      "GET",
      "/containers/cogmo-task-own/attach/ws?stream=1",
      `/containers/${OWN.id}/attach/ws?stream=1`,
    ],
    ["PUT", "/containers/own-child/archive?path=%2F", `/containers/${CHILD.id}/archive?path=%2F`],
    ["POST", "/containers/own-child/start", `/containers/${CHILD.id}/start`],
    ["POST", "/containers/own-child/stop?t=0", `/containers/${CHILD.id}/stop?t=0`],
    ["POST", "/containers/own-child/restart", `/containers/${CHILD.id}/restart`],
    ["POST", "/containers/own-child/kill?signal=KILL", `/containers/${CHILD.id}/kill?signal=KILL`],
    ["POST", "/containers/own-child/pause", `/containers/${CHILD.id}/pause`],
    ["POST", "/containers/own-child/unpause", `/containers/${CHILD.id}/unpause`],
    [
      "POST",
      "/containers/own-child/rename?name=other",
      `/containers/${CHILD.id}/rename?name=other`,
    ],
    ["DELETE", "/containers/own-child?force=true", `/containers/${CHILD.id}?force=true`],
  ])("forwards %s %s under the full id", async (method, path, forwarded) => {
    const r = await h.send(method, path);

    expect(r.status, r.body).toBe(200);
    const ref = path.includes("own-child") ? "own-child" : "cogmo-task-own";
    expect(h.received()).toEqual([resolveOf(ref), `${method} ${forwarded}`]);
  });

  it("forwards an exec create under the container's full id", async () => {
    const r = await h.send(
      "POST",
      "/containers/cogmo-task-own/exec",
      JSON.stringify({ Cmd: ["id"] }),
    );

    expect(r.status, r.body).toBe(201);
    expect(h.received()).toEqual([resolveOf("cogmo-task-own"), `POST /containers/${OWN.id}/exec`]);
  });

  it.each([
    ["a unique id prefix", "1a00"],
    ["the full id", OWN.id],
    ["a name", "cogmo-task-own"],
  ])("resolves %s", async (_label, ref) => {
    const r = await h.send("GET", `/containers/${ref}/json`);

    expect(r.status, r.body).toBe(200);
    expect(h.received()).toEqual([resolveOf(ref), `GET /containers/${OWN.id}/json`]);
  });

  it("forwards the canonical path and the re-serialised query, not the raw target", async () => {
    const r = await h.send("GET", "//containers/./cogmo-task-own//json?size=1&x=a%20b&x=c");

    expect(r.status, r.body).toBe(200);
    expect(h.received().at(-1)).toBe(`GET /containers/${OWN.id}/json?size=1&x=a+b&x=c`);
  });

  describe.each([
    ["a sibling task's container", SIBLING.name],
    ["a sibling task's container by id", SIBLING.id],
    ["Cogmo's own container", COGMO_OWN.id],
    ["an unknown id", UNKNOWN_ID],
    ["an ambiguous prefix", "4"],
  ])("%s", (_label, ref) => {
    it.each([
      ["GET", `/containers/${ref}/json`],
      ["GET", `/containers/${ref}/logs`],
      ["POST", `/containers/${ref}/kill`],
      ["POST", `/containers/${ref}/attach`],
      ["PUT", `/containers/${ref}/archive?path=%2F`],
      ["DELETE", `/containers/${ref}`],
    ])("gets the daemon's 404 on %s %s", async (method, path) => {
      const r = await h.send(method, path);

      h.expectRejected(r, 404, [resolveOf(ref)]);
      expect(message(r)).toBe(`No such container: ${ref}`);
    });

    it("gets the daemon's 404 on an exec create", async () => {
      const r = await h.send("POST", `/containers/${ref}/exec`, JSON.stringify({ Cmd: ["id"] }));

      h.expectRejected(r, 404, [resolveOf(ref)]);
      expect(message(r)).toBe(`No such container: ${ref}`);
    });
  });

  it.each([
    ["POST", "start"],
    ["POST", "stop"],
    ["POST", "restart"],
    ["POST", "kill"],
    ["POST", "pause"],
    ["POST", "unpause"],
    ["POST", "rename?name=x"],
  ])("denies %s /containers/{id}/%s on the task's own container", async (method, action) => {
    const r = await h.send(method, `/containers/cogmo-task-own/${action}`);

    h.expectRejected(r, 403, [resolveOf("cogmo-task-own")]);
  });

  it.each([
    ["DELETE", "/containers/cogmo-task-own?force=true"],
    ["PUT", "/containers/cogmo-task-own/archive?path=%2Fworkspace"],
  ])("denies %s %s on the task's own container", async (method, path) => {
    const r = await h.send(method, path);

    h.expectRejected(r, 403, [resolveOf("cogmo-task-own")]);
  });

  it("answers unavailable when the store read fails, before asking the daemon", async () => {
    h.rows.forTask.mockReturnValue(
      errAsync({ kind: "store_failed", cause: new Error("connection refused") }),
    );

    const r = await h.send("GET", "/containers/cogmo-task-own/json");

    h.expectRejected(r, 503, []);
    expect(message(r)).not.toContain("connection refused");
  });

  it.each([
    ["no rows", []],
    ["only a salvage row and a child, its own row reaped", [SALVAGE_ROW, CHILD_ROW]],
  ])("answers unavailable while the task's own row is missing: %s", async (_label, taskRows) => {
    h.rows.forTask.mockReturnValue(okAsync(taskRows));

    const r = await h.send("GET", "/containers/cogmo-task-own/json");

    h.expectRejected(r, 503, []);
  });

  it("anchors ownership to the scope's own row, not to the task id a salvage row shares", async () => {
    const r = await h.send("GET", `/containers/${SALVAGE.name}/json`);

    h.expectRejected(r, 404, [resolveOf(SALVAGE.name)]);
    expect(message(r)).toBe(`No such container: ${SALVAGE.name}`);
  });

  it("answers 500 and logs a check that throws", async () => {
    h.rows.forTask.mockImplementation(() => {
      throw new Error("a bug in the row reader");
    });

    const r = await h.send("GET", "/containers/cogmo-task-own/json");

    h.expectRejected(r, 500, []);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/containers/cogmo-task-own/json" }),
      "proxy checks failed",
    );
  });

  it("answers unavailable when the daemon resolve fails", async () => {
    h.daemon.setResponder((req, res, raw) =>
      req.url.endsWith("/json") && req.url.startsWith("/containers/")
        ? respondJson(res, 500, { message: "boom" })
        : API(req, res, raw),
    );

    const r = await h.send("GET", "/containers/cogmo-task-own/json");

    h.expectRejected(r, 503, [resolveOf("cogmo-task-own")]);
  });

  it.each(TESTCONTAINERS_CONTAINER_REQUESTS)(
    "forwards the recorded testcontainers $label on an owned container",
    async ({ method, path, headers, body }) => {
      const r = await h.send(method, path, body, { ...headers });

      expect(r.status, r.body).toBe(200);
      expect(h.received()).toEqual([resolveOf(RECORDED.id), `${method} ${path}`]);
    },
  );
});

describe("exec ownership", () => {
  async function createExec(ref: string, on: string): Promise<string> {
    const r = await requestOverSocket(on, {
      method: "POST",
      path: `/containers/${ref}/exec`,
      body: JSON.stringify({ Cmd: ["id"] }),
    });
    expect(r.status, r.body).toBe(201);
    return ExecCreatedSchema.parse(JSON.parse(r.body)).Id;
  }

  it.each([
    ["GET", "json", ""],
    ["POST", "resize", "?h=24&w=80"],
    ["POST", "start", ""],
  ])("forwards %s /exec/{id}/%s for an exec this socket created", async (method, action, query) => {
    const id = await createExec("cogmo-task-own", h.socket);

    const r = await h.send(method, `/exec/${id}/${action}${query}`);

    expect(r.status, r.body).toBe(200);
    expect(h.received().at(-1)).toBe(`${method} /exec/${id}/${action}${query}`);
  });

  it.each([
    ["GET", "json"],
    ["POST", "resize"],
    ["POST", "start"],
  ])(
    "answers 404 to %s /exec/{id}/%s for an exec the socket did not create",
    async (method, action) => {
      const id = "e".repeat(64);

      const r = await h.send(method, `/exec/${id}/${action}`);

      h.expectRejected(r, 404, []);
      expect(message(r)).toBe(`No such exec instance: ${id}`);
    },
  );

  it("forwards the recorded testcontainers exec create and inspect", async () => {
    const { create, inspect } = TESTCONTAINERS_EXEC_REQUESTS;
    const created = await h.send(create.method, create.path, create.body, { ...create.headers });
    expect(created.status, created.body).toBe(201);
    const id = ExecCreatedSchema.parse(JSON.parse(created.body)).Id;

    const path = inspect.path.replace("{id}", id);
    const r = await h.send(inspect.method, path, undefined, { ...inspect.headers });

    expect(r.status, r.body).toBe(200);
    expect(h.received()).toEqual([
      resolveOf(RECORDED.id),
      `${create.method} ${create.path}`,
      `${inspect.method} ${path}`,
    ]);
  });

  it("records no exec from a create the daemon refused, even one naming an id", async () => {
    const id = "f".repeat(64);
    h.daemon.setResponder((req, res, raw) =>
      req.method === "POST" && req.url.endsWith("/exec")
        ? respondJson(res, 409, { Id: id, message: "container is not running" })
        : API(req, res, raw),
    );

    const r = await h.send(
      "POST",
      "/containers/cogmo-task-own/exec",
      JSON.stringify({ Cmd: ["id"] }),
    );
    expect(r.status, r.body).toBe(409);
    expect(message(r)).toBe("container is not running");
    const before = h.received();

    const inspect = await h.send("GET", `/exec/${id}/json`);

    expect(inspect.status, inspect.body).toBe(404);
    expect(h.received()).toEqual(before);
  });

  it("answers daemon_failed to an exec create reply the daemon cut short", async () => {
    h.daemon.setResponder((req, res, raw) => {
      if (!(req.method === "POST" && req.url.endsWith("/exec"))) return API(req, res, raw);
      res.writeHead(201, { "content-type": "application/json", "content-length": "100" });
      res.write('{"Id":');
      res.destroy();
    });

    const r = await h.send(
      "POST",
      "/containers/cogmo-task-own/exec",
      JSON.stringify({ Cmd: ["id"] }),
    );

    expect(r.status, r.body).toBe(502);
  });

  it("keeps each task's exec ids to its own socket", async () => {
    const sibling = await h.proxy.registerTask(SIBLING_SCOPE);
    const theirs = await createExec(SIBLING.name, sibling);
    const before = h.received();

    const r = await h.send("GET", `/exec/${theirs}/json`);

    expect(r.status, r.body).toBe(404);
    expect(h.received()).toEqual(before);
  });

  it("matches an exec id that spans segments as the daemon routes it", async () => {
    const r = await h.send("GET", "/exec/dead/beef/json");

    h.expectRejected(r, 404, []);
    expect(message(r)).toBe("No such exec instance: dead/beef");
  });

  it("answers 404 to an upgrade to an exec the socket did not create", async () => {
    const reply = await h.rawExchange(upgradeRequest("POST", `/exec/${"e".repeat(64)}/start`));

    expect(reply).toMatch(/^HTTP\/1\.1 404 /);
    expect(h.received()).toEqual([]);
  });
});

describe("upgraded streams", () => {
  it("answers 404 to an upgrade to a container the task does not own", async () => {
    const reply = await h.rawExchange(
      upgradeRequest("POST", `/containers/${SIBLING.name}/attach?stream=1`),
    );

    expect(reply).toMatch(/^HTTP\/1\.1 404 /);
    expect(h.received()).toEqual([resolveOf(SIBLING.name)]);
  });

  it("opens no daemon connection for a client that hung up during the checks", async () => {
    const release = Promise.withResolvers<void>();
    h.daemon.setResponder((req, res, raw) => {
      if (req.url === `/containers/cogmo-task-own/json`) {
        release.promise.then(() => API(req, res, raw));
        return;
      }
      API(req, res, raw);
    });
    const client = net.createConnection({ path: h.socket });
    client.on("error", () => {});
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write(upgradeRequest("POST", "/containers/cogmo-task-own/attach?stream=1"));
    await vi.waitFor(() => expect(h.received()).toEqual([resolveOf("cogmo-task-own")]));

    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(h.received()).toEqual([resolveOf("cogmo-task-own")]);
  });

  it("answers 500 and logs an upgrade whose checks throw", async () => {
    h.rows.forTask.mockImplementation(() => {
      throw new Error("a bug in the row reader");
    });

    const reply = await h.rawExchange(upgradeRequest("POST", "/containers/cogmo-task-own/attach"));

    expect(reply).toMatch(/^HTTP\/1\.1 500 /);
    expect(h.received()).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/containers/cogmo-task-own/attach" }),
      "proxy upgrade checks failed",
    );
  });

  it("replays an owned attach under the full id", async () => {
    await h.rawExchange(
      upgradeRequest("POST", "/containers/cogmo-task-own/attach?stream=1&stdout=1"),
    );

    expect(h.received()).toEqual([
      resolveOf("cogmo-task-own"),
      `POST /containers/${OWN.id}/attach?stream=1&stdout=1`,
    ]);
  });
});
