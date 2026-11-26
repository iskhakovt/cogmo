/**
 * How the proxy follows a child's create, start and removal with the
 * `ChildContainers` writes, and answers each outcome, on the shared harness
 * (design/sandbox.md → Proxy Design → Child containers). The daemon answers
 * start and DELETE 204, as the daemon does.
 */

import * as net from "node:net";
import { errAsync, okAsync } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { expectDefined } from "../../test/assertions.js";
import { respondJson } from "../../test/fake-docker-daemon.js";
import {
  API,
  CHILD,
  CHILD_ROW,
  message,
  OWN_ROW,
  SCOPE,
  TASK_ROWS,
  upgradeRequest,
  useProxyHarness,
} from "../../test/proxy-harness.js";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../logger.js", () => ({ logger: { child: () => log } }));

const CreatedSchema = z.object({ Id: z.string() });

const h = useProxyHarness();

beforeEach(() => {
  h.daemon.setResponder((req, res, raw) => {
    if (/^\/containers\/[0-9a-f]{64}(\/start)?(\?|$)/.test(req.url) && req.method !== "GET") {
      res.writeHead(204);
      res.end();
      return;
    }
    API(req, res, raw);
  });
});

describe("a child's create", () => {
  it("records the child the 201 names under the task's own row, then answers 201", async () => {
    const r = await h.send("POST", "/containers/create", JSON.stringify({ Image: "alpine:3" }));

    expect(r.status, r.body).toBe(201);
    const [child] = expectDefined(h.children.record.mock.calls[0], "the record call");
    expect(child).toEqual({
      dockerId: CreatedSchema.parse(JSON.parse(r.body)).Id,
      parentId: OWN_ROW.id,
      rootTaskId: SCOPE.taskId,
      depth: 1,
      image: "alpine:3",
      runtime: SCOPE.runtime,
      labels: {
        "cogmo.managed": "true",
        "cogmo.instance": SCOPE.instanceId,
        "cogmo.root_task": SCOPE.taskId,
        "cogmo.parent": SCOPE.parentDockerId,
        "cogmo.depth": "1",
      },
      resourceLimits: { cpus: 2, memory_bytes: 1024 ** 3, pids: 256 },
      ttlExpiresAt: SCOPE.ttlExpiresAt,
      instanceId: SCOPE.instanceId,
    });
  });

  it("answers record_failed when the child's row cannot be recorded", async () => {
    h.children.record.mockReturnValue(errAsync({ kind: "record_failed" }));

    const r = await h.send("POST", "/containers/create", JSON.stringify({ Image: "alpine:3" }));

    expect(r.status, r.body).toBe(500);
    expect(message(r)).toContain("could not be recorded");
  });

  it("relays a daemon refusal and records nothing", async () => {
    h.daemon.setResponder((req, res, raw) =>
      req.url.startsWith("/containers/create")
        ? respondJson(res, 409, { message: "Conflict. The container name is already in use" })
        : API(req, res, raw),
    );

    const r = await h.send(
      "POST",
      "/containers/create?name=x",
      JSON.stringify({ Image: "alpine:3" }),
    );

    expect(r.status, r.body).toBe(409);
    expect(h.children.record).not.toHaveBeenCalled();
  });

  it("answers unavailable, before any daemon create, while the task's own row is missing", async () => {
    h.rows.forTask.mockReturnValue(okAsync(TASK_ROWS.filter((row) => row.id !== OWN_ROW.id)));

    const r = await h.send("POST", "/containers/create", JSON.stringify({ Image: "alpine:3" }));

    expect(r.status, r.body).toBe(503);
    expect(h.received().some((line) => line.startsWith("POST /containers/create"))).toBe(false);
  });

  it("answers unavailable, reading no rows, before the scope names its own row", async () => {
    await h.proxy.registerTask({ ...SCOPE, parentContainerRowId: null });

    const r = await h.send("POST", "/containers/create", JSON.stringify({ Image: "alpine:3" }));

    expect(r.status, r.body).toBe(503);
    expect(h.rows.forTask).not.toHaveBeenCalled();
  });

  it("records the child of a client that hung up before the daemon answered", async () => {
    const answer = Promise.withResolvers<void>();
    h.daemon.setResponder((req, res, raw) => {
      if (!req.url.startsWith("/containers/create")) return API(req, res, raw);
      void answer.promise.then(() => API(req, res, raw));
    });
    const body = JSON.stringify({ Image: "alpine:3" });
    const client = net.createConnection({ path: h.socket });
    client.on("error", () => {});
    client.write(
      `POST /containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    );
    await vi.waitFor(() =>
      expect(h.received().some((line) => line.startsWith("POST /containers/create"))).toBe(true),
    );

    client.destroy();
    answer.resolve();

    await vi.waitFor(() => expect(h.children.record).toHaveBeenCalledTimes(1));
  });

  it("answers 502 to a create whose daemon connection fails before an answer, recording nothing", async () => {
    h.daemon.setResponder((req, res, raw) =>
      req.url.startsWith("/containers/create") ? raw.socket.destroy() : API(req, res, raw),
    );

    const r = await h.send("POST", "/containers/create", JSON.stringify({ Image: "alpine:3" }));

    expect(r.status, r.body).toBe(502);
    expect(h.children.record).not.toHaveBeenCalled();
  });

  it("answers 502 to a 201 whose body is cut short, recording nothing", async () => {
    h.daemon.setResponder((req, res, raw) => {
      if (!req.url.startsWith("/containers/create")) return API(req, res, raw);
      res.writeHead(201, { "content-type": "application/json", "content-length": "200" });
      res.write('{"Id":"');
      setTimeout(() => raw.socket.destroy(), 20);
    });

    const r = await h.send("POST", "/containers/create", JSON.stringify({ Image: "alpine:3" }));

    expect(r.status, r.body).toBe(502);
    expect(message(r)).toContain("could not be read");
    expect(h.children.record).not.toHaveBeenCalled();
  });

  it("answers 500 and logs a record that throws", async () => {
    h.children.record.mockImplementation(() => {
      throw new Error("a bug in the row writer");
    });

    const r = await h.send("POST", "/containers/create", JSON.stringify({ Image: "alpine:3" }));

    expect(r.status, r.body).toBe(500);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/containers/create" }),
      "recording a created child failed",
    );
  });

  it("answers 400 to an upgrade of a create, forwarding nothing", async () => {
    const reply = await h.upgradeExchange(upgradeRequest("POST", "/containers/create"));

    expect(reply).toContain("400 Bad Request");
    expect(h.received()).toEqual([]);
  });
});

describe("a child's start", () => {
  it("moves the child's row once the daemon has started it", async () => {
    const r = await h.send("POST", `/containers/${CHILD.name}/start`);

    expect(r.status, r.body).toBe(204);
    expect(h.children.started).toHaveBeenCalledWith(CHILD_ROW);
  });

  it("answers 404 for a child whose row finished while it started", async () => {
    h.children.started.mockReturnValue(okAsync({ kind: "finished" }));

    const r = await h.send("POST", `/containers/${CHILD.name}/start`);

    expect(r.status, r.body).toBe(404);
    expect(message(r)).toBe(`No such container: ${CHILD.name}`);
  });

  it("answers the daemon's 204 when the running write fails, and logs it", async () => {
    h.children.started.mockReturnValue(errAsync({ kind: "store_failed", cause: new Error("x") }));

    const r = await h.send("POST", `/containers/${CHILD.name}/start`);

    expect(r.status, r.body).toBe(204);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ dockerId: CHILD.id }),
      "child running write failed",
    );
  });

  it("writes nothing for a start the daemon refuses", async () => {
    h.daemon.setResponder((req, res, raw) =>
      req.url.endsWith("/start")
        ? respondJson(res, 500, { message: "cannot start" })
        : API(req, res, raw),
    );

    const r = await h.send("POST", `/containers/${CHILD.name}/start`);

    expect(r.status, r.body).toBe(500);
    expect(h.children.started).not.toHaveBeenCalled();
  });

  it("moves the row on the daemon's 304 for a child already running", async () => {
    h.daemon.setResponder((req, res, raw) => {
      if (!req.url.endsWith("/start")) return API(req, res, raw);
      res.writeHead(304);
      res.end();
    });

    const r = await h.send("POST", `/containers/${CHILD.name}/start`);

    expect(r.status, r.body).toBe(304);
    expect(h.children.started).toHaveBeenCalledWith(CHILD_ROW);
  });
});

describe("a child's removal", () => {
  it("moves the child's row once the daemon has removed it", async () => {
    const r = await h.send("DELETE", `/containers/${CHILD.name}?force=1`);

    expect(r.status, r.body).toBe(204);
    expect(h.children.removed).toHaveBeenCalledWith(CHILD_ROW);
  });

  it("answers the daemon's 204 when the exited write fails, and logs it", async () => {
    h.children.removed.mockReturnValue(errAsync({ kind: "store_failed", cause: new Error("x") }));

    const r = await h.send("DELETE", `/containers/${CHILD.name}`);

    expect(r.status, r.body).toBe(204);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ dockerId: CHILD.id }),
      "child exited write failed",
    );
  });

  it("writes nothing for a removal the daemon refuses", async () => {
    h.daemon.setResponder((req, res, raw) =>
      req.method === "DELETE"
        ? respondJson(res, 409, { message: "container is running" })
        : API(req, res, raw),
    );

    const r = await h.send("DELETE", `/containers/${CHILD.name}`);

    expect(r.status, r.body).toBe(409);
    expect(h.children.removed).not.toHaveBeenCalled();
  });
});

describe("the child cap", () => {
  it("denies a create once 16 live children hang from any of the task's depth-0 rows", async () => {
    const children = Array.from({ length: 16 }, (_, n) => ({
      id: `019d0000-0000-7000-8000-0000000c${String(n).padStart(4, "0")}`,
      dockerId: `child-${n}`,
      // An earlier depth-0 row's children count too.
      parentId: n % 2 === 0 ? OWN_ROW.id : "019d0000-0000-7000-8000-00000000aaa0",
      status: n % 3 === 0 ? ("starting" as const) : ("running" as const),
    }));
    h.rows.forTask.mockReturnValue(okAsync([OWN_ROW, ...children]));

    const r = await h.send("POST", "/containers/create", JSON.stringify({ Image: "alpine:3" }));

    expect(r.status, r.body).toBe(403);
    expect(message(r)).toContain("16 live children");
    expect(h.received().some((line) => line.startsWith("POST /containers/create"))).toBe(false);
  });
});

describe("teardown", () => {
  it("answers an upgrade on an open connection unavailable while the task is torn down", async () => {
    const held = Promise.withResolvers<void>();
    h.daemon.setResponder((req, res, raw) => {
      if (!req.url.startsWith("/containers/create")) return API(req, res, raw);
      held.resolve();
      // Never answered: the create keeps the teardown waiting.
    });
    void h
      .send("POST", "/containers/create", JSON.stringify({ Image: "alpine:3" }))
      .catch(() => {});
    await held.promise;
    const client = net.createConnection({ path: h.socket });
    client.on("error", () => {});
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    const chunks: Buffer[] = [];
    client.on("data", (c: Buffer) => chunks.push(c));

    void h.proxy.unregisterTask(SCOPE.taskId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.write(upgradeRequest("POST", `/containers/${CHILD.name}/attach?stream=1`));

    await vi.waitFor(() =>
      expect(Buffer.concat(chunks).toString("latin1")).toContain("503 Service Unavailable"),
    );
  });
});
