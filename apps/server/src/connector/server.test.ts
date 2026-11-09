import { connect as connectHttp2, constants } from "node:http2";
import { create } from "@bufbuild/protobuf";
import {
  ConnectorService,
  type ConnectResponse,
  FinishJobRequestSchema,
  JobSchema,
} from "@cogmo/connector-proto";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport, createGrpcTransport } from "@connectrpc/connect-node";
import { ok } from "neverthrow";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { resolvesWithin } from "../test/assertions.js";
import { fakeRunInTx } from "../test/factories.js";
import { ConnectorAuth } from "./auth.js";
import { SessionHub } from "./hub.js";
import { type ConnectorServer, startConnectorServer } from "./server.js";
import type { ActiveConnector, ConnectorStore } from "./store/index.js";
import { hashConnectorToken } from "./token.js";

const PASEO: ActiveConnector = {
  id: "conn-paseo",
  name: "paseo",
  kind: "coding",
  tokenHash: hashConnectorToken("paseo-token"),
};
const AUTH = { headers: { authorization: "Bearer paseo-token" } };

let hub: SessionHub;
let server: ConnectorServer;
let baseUrl: string;

beforeEach(async () => {
  const store = mock<ConnectorStore>();
  store.listActive.mockResolvedValue([PASEO]);
  const auth = await ConnectorAuth.create({ runInTx: fakeRunInTx, connectorStore: store });
  hub = new SessionHub(auth, { leaseMs: 60_000 });
  server = await startConnectorServer({ hub, host: "127.0.0.1", port: 0 });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.close();
});

it("runs a job over gRPC on h2c, and close ends the stream with UNAVAILABLE", async () => {
  const client = createClient(ConnectorService, createGrpcTransport({ baseUrl }));
  const received: ConnectResponse[] = [];
  let firstMessage: () => void = () => {};
  const accepted = new Promise<void>((resolve) => {
    firstMessage = resolve;
  });
  const stream = (async () => {
    try {
      for await (const message of client.connect({ heldJobIds: [] }, AUTH)) {
        received.push(message);
        firstMessage();
      }
      return null;
    } catch (error) {
      return ConnectError.from(error).code;
    }
  })();
  await resolvesWithin(accepted, 5_000, "SessionAccepted");

  const job = create(JobSchema, {
    jobId: "task-1/publish/d1",
    taskId: "task-1",
    spec: { case: "publish", value: { commitMessage: "m", workBranch: "cogmo/t" } },
  });
  const run = hub.run(PASEO.id, job, { onEvent: () => {} });
  await client.acceptJob({ jobId: job.jobId }, AUTH);
  await client.finishJob(
    create(FinishJobRequestSchema, {
      jobId: job.jobId,
      outcome: {
        case: "completed",
        value: { result: { case: "published", value: { headSha: "abc" } } },
      },
    }),
    AUTH,
  );
  expect(await resolvesWithin(run, 5_000, "the job's outcome")).toEqual(
    ok(expect.objectContaining({ kind: "completed" })),
  );
  expect(received.map((m) => m.message.case)).toEqual(["accepted", "job"]);

  await resolvesWithin(server.close(), 5_000, "server close");
  expect(await resolvesWithin(stream, 5_000, "the stream's end")).toBe(Code.Unavailable);
});

it("refuses a call without a token", async () => {
  const client = createClient(ConnectorService, createGrpcTransport({ baseUrl }));
  await expect(client.acceptJob({ jobId: "x" })).rejects.toMatchObject({
    code: Code.Unauthenticated,
  });
});

it("serves only the gRPC protocol", async () => {
  const client = createClient(
    ConnectorService,
    createConnectTransport({ baseUrl, httpVersion: "2" }),
  );
  // Served, this call would fail NOT_FOUND on the unknown job; it never reaches the hub.
  await expect(client.acceptJob({ jobId: "x" }, AUTH)).rejects.toMatchObject({
    code: Code.Unknown,
    rawMessage: "HTTP 415",
  });
});

it("closes within its grace when a request body never finishes", async () => {
  const session = connectHttp2(baseUrl);
  session.on("error", () => {});
  const request = session.request({
    ":method": "POST",
    ":path": "/cogmo.connector.v1.ConnectorService/AcceptJob",
    "content-type": "application/grpc",
    authorization: "Bearer paseo-token",
  });
  request.on("error", () => {});
  request.write(Buffer.from([0, 0, 0, 0, 16]));
  await new Promise((resolve) => setTimeout(resolve, 100));

  await resolvesWithin(server.close(), 4_000, "server close");
  session.destroy();
});

it("refuses a message larger than 4 MiB", async () => {
  const client = createClient(ConnectorService, createGrpcTransport({ baseUrl }));
  await expect(
    client.acceptJob({ jobId: "x".repeat(4 * 1024 * 1024 + 1) }, AUTH),
  ).rejects.toMatchObject({ code: Code.ResourceExhausted });
});

it("resets a replaced session's stream that its peer stopped reading", async () => {
  // A peer advertising a zero window takes no data, so the server's writes queue up.
  const stuck = connectHttp2(baseUrl, { settings: { initialWindowSize: 0 } });
  stuck.on("error", () => {});
  const request = stuck.request({
    ":method": "POST",
    ":path": "/cogmo.connector.v1.ConnectorService/Connect",
    "content-type": "application/grpc",
    te: "trailers",
    authorization: "Bearer paseo-token",
  });
  request.on("error", () => {});
  let isClosed = false;
  const closed = new Promise<void>((resolve) =>
    request.on("close", () => {
      isClosed = true;
      resolve();
    }),
  );
  // Headers aren't flow-controlled, so they arrive once the server has opened the session.
  const responded = new Promise<void>((resolve) => request.once("response", () => resolve()));
  request.end(Buffer.from([0, 0, 0, 0, 0]));
  await resolvesWithin(responded, 4_000, "the stuck stream's response headers");
  expect(isClosed).toBe(false);

  // A second session for the same connector replaces the first.
  const client = createClient(ConnectorService, createGrpcTransport({ baseUrl }));
  const controller = new AbortController();
  const { promise: accepted, resolve: firstMessage } = Promise.withResolvers<ConnectResponse>();
  const second = (async () => {
    try {
      for await (const message of client.connect(
        { heldJobIds: [] },
        { ...AUTH, signal: controller.signal },
      )) {
        firstMessage(message);
      }
    } catch {
      // Aborted below.
    }
  })();
  expect(
    (await resolvesWithin(accepted, 4_000, "the replacement's first message")).message.case,
  ).toBe("accepted");

  await resolvesWithin(closed, 4_000, "the stuck stream's reset");
  expect(request.rstCode).toBe(constants.NGHTTP2_CANCEL);
  controller.abort();
  await second;
  stuck.destroy();
});
