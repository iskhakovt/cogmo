import { describe, expect, it } from "vitest";
import { expectDefined } from "../../test/assertions.js";
import { BRIDGE_NETWORK, respondJson } from "../../test/fake-docker-daemon.js";
import {
  API,
  api,
  message,
  OWN,
  RECORDED_BRIDGE,
  SALVAGE,
  SIBLING,
  TASK_NETWORK,
  UNKNOWN_ID,
  useProxyHarness,
} from "../../test/proxy-harness.js";
import { TESTCONTAINERS_BRIDGE_CONNECT_REQUEST } from "../../test/testcontainers-requests.js";

const h = useProxyHarness();

describe("network connect and disconnect", () => {
  const BRIDGE_REFS = [
    ["by name", "bridge"],
    ["by id", BRIDGE_NETWORK.id],
    ["by id prefix", BRIDGE_NETWORK.id.slice(0, 12)],
  ];

  it.each(BRIDGE_REFS)(
    "forwards an owned container's connect to bridge %s with both refs rewritten",
    async (_label, ref) => {
      const r = await h.send(
        "POST",
        `/networks/${ref}/connect`,
        JSON.stringify({ Container: "cogmo-task-own", EndpointConfig: { Aliases: [] } }),
      );

      expect(r.status, r.body).toBe(200);
      const forwarded = expectDefined(h.daemon.requests().at(-1), "connect");
      expect(`${forwarded.method} ${forwarded.url}`).toBe(
        `POST /networks/${BRIDGE_NETWORK.id}/connect`,
      );
      expect(JSON.parse(forwarded.body)).toEqual({
        Container: OWN.id,
        EndpointConfig: { Aliases: [] },
      });
    },
  );

  it("forwards an owned container's disconnect from bridge with Force", async () => {
    const r = await h.send(
      "POST",
      "/networks/bridge/disconnect",
      JSON.stringify({ Container: OWN.id.slice(0, 12), Force: true }),
    );

    expect(r.status, r.body).toBe(200);
    const forwarded = expectDefined(h.daemon.requests().at(-1), "disconnect");
    expect(`${forwarded.method} ${forwarded.url}`).toBe(
      `POST /networks/${BRIDGE_NETWORK.id}/disconnect`,
    );
    expect(JSON.parse(forwarded.body)).toEqual({ Container: OWN.id, Force: true });
  });

  it("forwards the recorded testcontainers port-forwarder connect to bridge", async () => {
    h.daemon.setResponder(api([RECORDED_BRIDGE]));
    const req = TESTCONTAINERS_BRIDGE_CONNECT_REQUEST;

    const r = await h.send(req.method, req.path, req.body, { ...req.headers });

    expect(r.status, r.body).toBe(200);
    const forwarded = expectDefined(h.daemon.requests().at(-1), "connect");
    expect(`${forwarded.method} ${forwarded.url}`).toBe(`${req.method} ${req.path}`);
    expect(JSON.parse(forwarded.body)).toEqual(JSON.parse(req.body));
  });

  it.each([
    ["a task network", "task-net"],
    ["the host network", "host"],
    ["a missing network", "no-such-net"],
  ])("denies a connect to %s", async (_label, ref) => {
    const r = await h.send(
      "POST",
      `/networks/${ref}/connect`,
      JSON.stringify({ Container: "cogmo-task-own" }),
    );

    expect(r.status, r.body).toBe(403);
    expect(h.received().filter((line) => line.startsWith("POST"))).toEqual([]);
  });

  it.each([
    ["/v1.44", 200],
    ["/v1.43", 403],
  ])(
    "keeps the version prefix %s on a disconnect, or denies it below the floor",
    async (prefix, status) => {
      const r = await h.send(
        "POST",
        `${prefix}/networks/bridge/disconnect`,
        JSON.stringify({ Container: "cogmo-task-own" }),
      );

      expect(r.status, r.body).toBe(status);
      const posts = h.received().filter((line) => line.startsWith("POST"));
      expect(posts).toEqual(
        status === 200 ? [`POST ${prefix}/networks/${BRIDGE_NETWORK.id}/disconnect`] : [],
      );
    },
  );

  it("denies a disconnect from a missing network, forwarding nothing", async () => {
    const r = await h.send(
      "POST",
      "/networks/no-such-net/disconnect",
      JSON.stringify({ Container: "cogmo-task-own" }),
    );

    expect(r.status, r.body).toBe(403);
    expect(h.received().filter((line) => line.startsWith("POST"))).toEqual([]);
  });

  it("denies a bridge disconnect body that sets EndpointConfig, before any lookup", async () => {
    const r = await h.send(
      "POST",
      "/networks/bridge/disconnect",
      JSON.stringify({ Container: "cogmo-task-own", EndpointConfig: { Aliases: ["x"] } }),
    );

    h.expectRejected(r, 403, []);
  });

  it.each(["../cogmo-task-own", "./cogmo-task-own", "/cogmo-task-own", "a//b", "x/.."])(
    "answers 404 to a body Container %j before any lookup",
    async (ref) => {
      const r = await h.send(
        "POST",
        "/networks/bridge/connect",
        JSON.stringify({ Container: ref }),
      );

      h.expectRejected(r, 404, []);
      expect(message(r)).toBe(`No such container: ${ref}`);
    },
  );

  it("answers 404 to a bridge connect of the task's salvage container", async () => {
    const r = await h.send(
      "POST",
      "/networks/bridge/connect",
      JSON.stringify({ Container: SALVAGE.name }),
    );

    expect(r.status, r.body).toBe(404);
    expect(h.received().filter((line) => line.startsWith("POST"))).toEqual([]);
  });

  it("denies a disconnect from a network other than bridge", async () => {
    const r = await h.send(
      "POST",
      "/networks/task-net/disconnect",
      JSON.stringify({ Container: "cogmo-task-own" }),
    );

    expect(r.status, r.body).toBe(403);
    expect(h.received().filter((line) => line.startsWith("POST"))).toEqual([]);
  });

  it("answers unavailable when the daemon has no bridge network", async () => {
    h.daemon.setResponder(api([TASK_NETWORK]));

    const r = await h.send(
      "POST",
      "/networks/task-net/connect",
      JSON.stringify({ Container: "cogmo-task-own" }),
    );

    expect(r.status, r.body).toBe(503);
    expect(h.received().filter((line) => line.startsWith("POST"))).toEqual([]);
  });

  it("answers unavailable when the network resolve fails", async () => {
    h.daemon.setResponder((req, res, raw) =>
      req.method === "GET" && req.url.startsWith("/networks/")
        ? respondJson(res, 500, { message: "boom" })
        : API(req, res, raw),
    );

    const r = await h.send(
      "POST",
      "/networks/bridge/connect",
      JSON.stringify({ Container: "cogmo-task-own" }),
    );

    expect(r.status, r.body).toBe(503);
    expect(h.received().filter((line) => line.startsWith("POST"))).toEqual([]);
  });

  it("answers 400 to a connect body without a Container", async () => {
    const r = await h.send("POST", "/networks/bridge/connect", JSON.stringify({}));

    h.expectRejected(r, 400, []);
  });

  it.each([
    ["connect", SIBLING.name],
    ["disconnect", SIBLING.id],
    ["connect", UNKNOWN_ID],
  ])("answers 404 to a bridge %s of a container the task does not own", async (op, ref) => {
    const r = await h.send("POST", `/networks/bridge/${op}`, JSON.stringify({ Container: ref }));

    expect(r.status, r.body).toBe(404);
    expect(message(r)).toBe(`No such container: ${ref}`);
    expect(h.received().filter((line) => line.startsWith("POST"))).toEqual([]);
  });

  it.each([
    ["EndpointConfig.IPAMConfig", { IPAMConfig: { IPv4Address: "172.17.0.99" } }],
    ["EndpointConfig.Links", { Links: [`${SIBLING.name}:db`] }],
  ])("denies a connect body that sets %s", async (_label, endpoint) => {
    const r = await h.send(
      "POST",
      "/networks/bridge/connect",
      JSON.stringify({ Container: "cogmo-task-own", EndpointConfig: endpoint }),
    );

    expect(r.status, r.body).toBe(403);
    expect(h.received().filter((line) => line.startsWith("POST"))).toEqual([]);
  });
});
