import type { MessageInitShape } from "@bufbuild/protobuf";
import { create } from "@bufbuild/protobuf";
import {
  ConnectorService,
  type ConnectResponse,
  type FinishJobRequest,
  FinishJobRequestSchema,
  type Job,
  JobErrorCode,
  type JobEvent,
  JobEventSchema,
  JobSchema,
} from "@cogmo/connector-proto";
import {
  type Client,
  Code,
  ConnectError,
  createClient,
  createRouterTransport,
} from "@connectrpc/connect";
import { err, ok, type Result } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { JobOutcome, JobRunError } from "../agent/coding/connector-jobs.js";
import { expectDefined, expectOk } from "../test/assertions.js";
import { fakeRunInTx } from "../test/factories.js";
import { SessionHub } from "./hub.js";
import { connectorRoutes } from "./service.js";
import type { ActiveConnector, ConnectorStore } from "./store/index.js";
import { hashConnectorToken } from "./token.js";

const LEASE_MS = 120_000;
const MINUTE = 60_000;

const PASEO: ActiveConnector = {
  id: "conn-paseo",
  name: "paseo",
  kind: "coding",
  tokenHash: hashConnectorToken("paseo-token"),
};
const OTHER: ActiveConnector = {
  id: "conn-other",
  name: "other",
  kind: "coding",
  tokenHash: hashConnectorToken("other-token"),
};

type ConnectorClient = Client<typeof ConnectorService>;
type RunResult = Result<JobOutcome, JobRunError>;

let store: ReturnType<typeof mock<ConnectorStore>>;
let hub: SessionHub;
let client: ConnectorClient;

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  store = mock<ConnectorStore>();
  store.listActive.mockResolvedValue([PASEO, OTHER]);
  hub = await SessionHub.create(
    { runInTx: fakeRunInTx, connectorStore: store },
    { leaseMs: LEASE_MS },
  );
  client = createClient(ConnectorService, createRouterTransport(connectorRoutes(hub)));
});

afterEach(() => {
  hub.close();
  vi.useRealTimers();
});

/** Lets the in-memory transport deliver what is queued; real `setImmediate`. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

function bearer(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

/** A fake connector's `Connect` stream, recording what cogmo sends. */
function openStream(token: string, heldJobIds: string[]) {
  const controller = new AbortController();
  const received: ConnectResponse[] = [];
  const state: { error: ConnectError | null } = { error: null };
  const done = (async () => {
    try {
      for await (const message of client.connect(
        { heldJobIds },
        { ...bearer(token), signal: controller.signal },
      )) {
        received.push(message);
      }
    } catch (error) {
      state.error = ConnectError.from(error);
    }
  })();
  return {
    received,
    done,
    get error() {
      return state.error;
    },
    disconnect: async () => {
      controller.abort();
      await done;
      await settle();
    },
    jobs: () => received.flatMap((m) => (m.message.case === "job" ? [m.message.value.jobId] : [])),
    cancels: () =>
      received.flatMap((m) => (m.message.case === "cancel" ? [m.message.value.jobId] : [])),
    awaited: () => {
      const first = expectDefined(received[0], "first message");
      if (first.message.case !== "accepted") throw new Error("first message is not accepted");
      return first.message.value.awaitedJobIds;
    },
  };
}

async function connected(token: string, heldJobIds: string[]) {
  const stream = openStream(token, heldJobIds);
  await settle();
  return stream;
}

function prepareJob(): Job {
  return create(JobSchema, {
    jobId: "task-1/prepare/d1",
    taskId: "task-1",
    spec: {
      case: "prepare",
      value: { remoteUrl: "git@github.com:o/r.git", baseBranch: "main", workBranch: "cogmo/t" },
    },
  });
}

function planJob(tokenBudget: bigint): Job {
  return create(JobSchema, {
    jobId: "task-1/plan/d2",
    taskId: "task-1",
    spec: { case: "plan", value: { prompt: "plan it", agent: "claude", tokenBudget } },
  });
}

function verifyJob(timeoutSeconds: number): Job {
  return create(JobSchema, {
    jobId: "task-1/verify/d3",
    taskId: "task-1",
    spec: { case: "verify", value: { command: "pnpm test", timeoutSeconds } },
  });
}

function releaseJob(): Job {
  return create(JobSchema, {
    jobId: "task-1/release/d4",
    taskId: "task-1",
    spec: { case: "release", value: {} },
  });
}

function textEvent(seq: bigint, text: string): JobEvent {
  return create(JobEventSchema, { seq, event: { case: "textDelta", value: text } });
}

function usageEvent(seq: bigint, inputTokens: bigint, outputTokens: bigint): JobEvent {
  return create(JobEventSchema, {
    seq,
    event: { case: "usage", value: { inputTokens, outputTokens, costUsd: 0 } },
  });
}

function finish(init: MessageInitShape<typeof FinishJobRequestSchema>): FinishJobRequest {
  return create(FinishJobRequestSchema, init);
}

const PREPARED = finish({
  jobId: "task-1/prepare/d1",
  outcome: { case: "completed", value: { result: { case: "prepared", value: {} } } },
});

/** Starts `run` and records its outcome once it settles. */
function startRun(job: Job) {
  const events: JobEvent[] = [];
  const state: { result: RunResult | null } = { result: null };
  void hub.run(PASEO.id, job, { onEvent: (event) => events.push(event) }).then((result) => {
    state.result = result;
  });
  return {
    events,
    get result() {
      return state.result;
    },
  };
}

async function callError(call: Promise<unknown>): Promise<Code> {
  try {
    await call;
  } catch (error) {
    return ConnectError.from(error).code;
  }
  throw new Error("expected the call to fail");
}

describe("auth", () => {
  it("refuses a call without a bearer token", async () => {
    expect(await callError(client.acceptJob({ jobId: "x" }))).toBe(Code.Unauthenticated);
  });

  it("refuses an unknown token", async () => {
    expect(await callError(client.acceptJob({ jobId: "x" }, bearer("nope")))).toBe(
      Code.Unauthenticated,
    );
  });

  it("refreshes the cache for an unknown token at most once every 5 s", async () => {
    const added: ActiveConnector = {
      ...OTHER,
      id: "conn-new",
      tokenHash: hashConnectorToken("new"),
    };
    store.listActive.mockResolvedValue([PASEO, OTHER, added]);
    await advance(1_000);
    expect(await callError(client.acceptJob({ jobId: "x" }, bearer("new")))).toBe(
      Code.Unauthenticated,
    );
    // Only the load at create.
    expect(store.listActive).toHaveBeenCalledTimes(1);
    await advance(5_000);
    // Authenticated now, so the call fails on the unknown job instead.
    expect(await callError(client.acceptJob({ jobId: "x" }, bearer("new")))).toBe(Code.NotFound);
    expect(store.listActive).toHaveBeenCalledTimes(2);
  });

  it("answers UNAVAILABLE when the refresh for an unknown token fails", async () => {
    store.listActive.mockRejectedValue(new Error("db down"));
    await advance(5_000);
    expect(await callError(client.acceptJob({ jobId: "x" }, bearer("new")))).toBe(Code.Unavailable);
  });

  it("fails closed with UNAVAILABLE once the cache has gone 90 s without a refresh", async () => {
    store.listActive.mockRejectedValue(new Error("db down"));
    await advance(60_000);
    // Refreshes failing for 60 s: the cached token still works.
    expect(await callError(client.acceptJob({ jobId: "x" }, bearer("paseo-token")))).toBe(
      Code.NotFound,
    );
    await advance(30_000);
    expect(await callError(client.acceptJob({ jobId: "x" }, bearer("paseo-token")))).toBe(
      Code.Unavailable,
    );
  });

  it("closes every stream with UNAVAILABLE once the cache is stale", async () => {
    const stream = await connected("paseo-token", []);
    store.listActive.mockRejectedValue(new Error("db down"));
    await advance(60_000);
    expect(stream.error).toBeNull();
    await advance(30_000);
    await stream.done;
    expect(stream.error?.code).toBe(Code.Unavailable);
  });

  it("lets concurrent calls with a new token share the refresh the first one started", async () => {
    const added: ActiveConnector = {
      ...OTHER,
      id: "conn-new",
      tokenHash: hashConnectorToken("new"),
    };
    store.listActive.mockResolvedValue([PASEO, OTHER, added]);
    await advance(5_000);
    const codes = await Promise.all([
      callError(client.acceptJob({ jobId: "x" }, bearer("new"))),
      callError(client.acceptJob({ jobId: "y" }, bearer("new"))),
    ]);
    // Authenticated, so both fail on the unknown job.
    expect(codes).toEqual([Code.NotFound, Code.NotFound]);
  });

  it("keeps answering UNAVAILABLE for an unknown token within 5 s of a failed refresh", async () => {
    store.listActive.mockRejectedValue(new Error("db down"));
    await advance(5_000);
    expect(await callError(client.acceptJob({ jobId: "x" }, bearer("new")))).toBe(Code.Unavailable);
    expect(await callError(client.acceptJob({ jobId: "x" }, bearer("new")))).toBe(Code.Unavailable);
  });

  it("dates staleness from when the last good load started", async () => {
    const stream = await connected("paseo-token", []);
    store.listActive.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve([PASEO, OTHER]), 1_000)),
    );
    store.listActive.mockRejectedValue(new Error("db down"));
    // A good load from 30 s to 31 s, then failures at 60, 90 and 120 s.
    await advance(120_000);
    await stream.done;
    expect(stream.error?.code).toBe(Code.Unavailable);
  });

  it("closes a revoked connector's stream at the next refresh, and its accepted job is lost", async () => {
    const stream = await connected("paseo-token", []);
    const run = startRun(prepareJob());
    await settle();
    await client.acceptJob({ jobId: "task-1/prepare/d1" }, bearer("paseo-token"));

    store.listActive.mockResolvedValue([OTHER]);
    await advance(30_000);
    await stream.done;
    expect(stream.error?.code).toBe(Code.Unauthenticated);
    expect(await callError(client.acceptJob({ jobId: "x" }, bearer("paseo-token")))).toBe(
      Code.Unauthenticated,
    );

    await advance(LEASE_MS);
    expect(run.result).toEqual(err({ kind: "lost" }));
  });

  it("carries a job over when a rotated connector reconnects with its new token within the lease", async () => {
    const stream = await connected("paseo-token", []);
    const run = startRun(prepareJob());
    await settle();
    await client.acceptJob({ jobId: "task-1/prepare/d1" }, bearer("paseo-token"));

    const rotated: ActiveConnector = { ...PASEO, tokenHash: hashConnectorToken("rotated") };
    store.listActive.mockResolvedValue([rotated, OTHER]);
    await advance(30_000);
    await stream.done;
    expect(stream.error?.code).toBe(Code.Unauthenticated);

    const again = await connected("rotated", ["task-1/prepare/d1"]);
    expect(again.awaited()).toEqual(["task-1/prepare/d1"]);
    await client.finishJob(PREPARED, bearer("rotated"));
    await settle();
    expect(run.result).toEqual(ok(expect.objectContaining({ kind: "completed" })));
  });
});

describe("a job's life", () => {
  it("sends the job after SessionAccepted, delivers new events in order, and resolves on FinishJob", async () => {
    const stream = await connected("paseo-token", []);
    const run = startRun(planJob(0n));
    await settle();
    expect(stream.received[0]?.message.case).toBe("accepted");
    expect(stream.jobs()).toEqual(["task-1/plan/d2"]);

    const auth = bearer("paseo-token");
    await client.acceptJob({ jobId: "task-1/plan/d2" }, auth);
    await client.reportEvents(
      { jobId: "task-1/plan/d2", events: [textEvent(1n, "a"), textEvent(2n, "b")] },
      auth,
    );
    // A retried report re-sends the same seqs: dropped.
    await client.reportEvents(
      { jobId: "task-1/plan/d2", events: [textEvent(2n, "b"), textEvent(3n, "c")] },
      auth,
    );
    await client.finishJob(
      finish({
        jobId: "task-1/plan/d2",
        lastSeq: 3n,
        outcome: {
          case: "completed",
          value: { result: { case: "plan", value: { plan: "the plan", sessionId: "s-1" } } },
        },
      }),
      auth,
    );
    await settle();

    expect(run.events.map((e) => e.seq)).toEqual([1n, 2n, 3n]);
    expect(expectOk(expectDefined(run.result, "result"))).toMatchObject({
      kind: "completed",
      result: { result: { case: "plan", value: { plan: "the plan", sessionId: "s-1" } } },
    });
  });

  it("waits for a session when none is open, then sends the job", async () => {
    const run = startRun(prepareJob());
    await advance(LEASE_MS - 1_000);
    const stream = await connected("paseo-token", []);
    expect(stream.awaited()).toEqual(["task-1/prepare/d1"]);
    expect(stream.jobs()).toEqual(["task-1/prepare/d1"]);
    await client.finishJob(PREPARED, bearer("paseo-token"));
    await settle();
    expect(run.result).toEqual(ok(expect.objectContaining({ kind: "completed" })));
  });

  it("is unavailable when no session carries it within the lease", async () => {
    const run = startRun(prepareJob());
    await advance(LEASE_MS);
    expect(run.result).toEqual(err({ kind: "unavailable" }));
  });

  it("is unavailable when an open session does not accept it within the lease", async () => {
    await connected("paseo-token", []);
    const run = startRun(prepareJob());
    await advance(LEASE_MS);
    expect(run.result).toEqual(err({ kind: "unavailable" }));
  });

  it("does not restart the acceptance lease on a reconnect", async () => {
    const first = await connected("paseo-token", []);
    const run = startRun(prepareJob());
    await advance(LEASE_MS - 1_000);
    await first.disconnect();
    await connected("paseo-token", ["task-1/prepare/d1"]);
    await advance(1_000);
    expect(run.result).toEqual(err({ kind: "unavailable" }));
  });

  it("treats FinishJob on a dispatched job as accepted", async () => {
    await connected("paseo-token", []);
    const run = startRun(prepareJob());
    await settle();
    await client.finishJob(PREPARED, bearer("paseo-token"));
    await settle();
    expect(run.result).toEqual(ok(expect.objectContaining({ kind: "completed" })));
  });

  it("keeps the first outcome and acknowledges a later FinishJob or report", async () => {
    await connected("paseo-token", []);
    const run = startRun(prepareJob());
    await settle();
    const auth = bearer("paseo-token");
    await client.finishJob(PREPARED, auth);
    await client.finishJob(
      finish({ jobId: "task-1/prepare/d1", outcome: { case: "cancelled", value: {} } }),
      auth,
    );
    await client.reportEvents({ jobId: "task-1/prepare/d1", events: [textEvent(1n, "x")] }, auth);
    await settle();
    expect(run.result).toEqual(ok(expect.objectContaining({ kind: "completed" })));
    expect(run.events).toEqual([]);
  });

  it("refuses a late AcceptJob with NOT_FOUND", async () => {
    startRun(prepareJob());
    await advance(LEASE_MS);
    await connected("paseo-token", []);
    expect(
      await callError(client.acceptJob({ jobId: "task-1/prepare/d1" }, bearer("paseo-token"))),
    ).toBe(Code.NotFound);
  });

  it("refuses calls naming an unknown job, or another connector's", async () => {
    await connected("paseo-token", []);
    startRun(prepareJob());
    await settle();
    const other = bearer("other-token");
    expect(await callError(client.acceptJob({ jobId: "nope" }, other))).toBe(Code.NotFound);
    expect(await callError(client.acceptJob({ jobId: "task-1/prepare/d1" }, other))).toBe(
      Code.PermissionDenied,
    );
    expect(
      await callError(client.reportEvents({ jobId: "task-1/prepare/d1", events: [] }, other)),
    ).toBe(Code.PermissionDenied);
    expect(await callError(client.finishJob(PREPARED, other))).toBe(Code.PermissionDenied);
  });

  it("fails the job and answers INVALID_ARGUMENT when the result does not match the job", async () => {
    await connected("paseo-token", []);
    const run = startRun(prepareJob());
    await settle();
    const mismatched = finish({
      jobId: "task-1/prepare/d1",
      outcome: { case: "completed", value: { result: { case: "published", value: {} } } },
    });
    expect(await callError(client.finishJob(mismatched, bearer("paseo-token")))).toBe(
      Code.InvalidArgument,
    );
    await settle();
    expect(expectOk(expectDefined(run.result, "result"))).toMatchObject({
      kind: "failed",
      error: { code: JobErrorCode.UNSPECIFIED },
    });
  });

  it("answers INVALID_ARGUMENT for a FinishJob without an outcome, leaving the job open", async () => {
    await connected("paseo-token", []);
    const run = startRun(prepareJob());
    await settle();
    const empty = finish({ jobId: "task-1/prepare/d1" });
    expect(await callError(client.finishJob(empty, bearer("paseo-token")))).toBe(
      Code.InvalidArgument,
    );
    await client.finishJob(PREPARED, bearer("paseo-token"));
    await settle();
    expect(run.result).toEqual(ok(expect.objectContaining({ kind: "completed" })));
  });

  it("keeps delivering events when a handler throws", async () => {
    await connected("paseo-token", []);
    const seen: bigint[] = [];
    void hub.run(PASEO.id, planJob(0n), {
      onEvent: () => {
        throw new Error("handler bug");
      },
    });
    void hub.run(PASEO.id, planJob(0n), { onEvent: (event) => seen.push(event.seq) });
    await settle();
    await client.reportEvents(
      { jobId: "task-1/plan/d2", events: [textEvent(1n, "a"), textEvent(2n, "b")] },
      bearer("paseo-token"),
    );
    expect(seen).toEqual([1n, 2n]);
  });
});

describe("run on a held job_id", () => {
  it("joins a job in flight without sending it again", async () => {
    const stream = await connected("paseo-token", []);
    const first = startRun(prepareJob());
    const second = startRun(prepareJob());
    await settle();
    expect(stream.jobs()).toEqual(["task-1/prepare/d1"]);
    await client.finishJob(PREPARED, bearer("paseo-token"));
    await settle();
    expect(first.result).toEqual(ok(expect.objectContaining({ kind: "completed" })));
    expect(second.result).toEqual(ok(expect.objectContaining({ kind: "completed" })));
  });

  it("returns a stored completed outcome without sending anything", async () => {
    const stream = await connected("paseo-token", []);
    startRun(prepareJob());
    await settle();
    await client.finishJob(PREPARED, bearer("paseo-token"));
    await settle();
    const again = startRun(prepareJob());
    await settle();
    expect(again.result).toEqual(ok(expect.objectContaining({ kind: "completed" })));
    expect(stream.jobs()).toEqual(["task-1/prepare/d1"]);
  });

  it("dispatches again after an unavailable end", async () => {
    startRun(prepareJob());
    await advance(LEASE_MS);
    const stream = await connected("paseo-token", []);
    expect(stream.jobs()).toEqual([]);
    const again = startRun(prepareJob());
    await settle();
    expect(stream.jobs()).toEqual(["task-1/prepare/d1"]);
    await client.finishJob(PREPARED, bearer("paseo-token"));
    await settle();
    expect(again.result).toEqual(ok(expect.objectContaining({ kind: "completed" })));
  });
});

describe("sessions", () => {
  it("carries an accepted job over a reconnect within the lease that holds it", async () => {
    const stream = await connected("paseo-token", []);
    const run = startRun(prepareJob());
    await settle();
    await client.acceptJob({ jobId: "task-1/prepare/d1" }, bearer("paseo-token"));
    await stream.disconnect();
    await advance(LEASE_MS - 1_000);

    const again = await connected("paseo-token", ["task-1/prepare/d1"]);
    expect(again.awaited()).toEqual(["task-1/prepare/d1"]);
    expect(again.jobs()).toEqual([]);
    await advance(LEASE_MS);
    expect(run.result).toBeNull();
    await client.finishJob(PREPARED, bearer("paseo-token"));
    await settle();
    expect(run.result).toEqual(ok(expect.objectContaining({ kind: "completed" })));
  });

  it("loses an accepted job a new session does not hold", async () => {
    const stream = await connected("paseo-token", []);
    const run = startRun(prepareJob());
    await settle();
    await client.acceptJob({ jobId: "task-1/prepare/d1" }, bearer("paseo-token"));
    await stream.disconnect();

    const again = await connected("paseo-token", []);
    expect(again.awaited()).toEqual([]);
    expect(run.result).toEqual(err({ kind: "lost" }));
  });

  it("loses an accepted job when no session returns within the lease", async () => {
    const stream = await connected("paseo-token", []);
    const run = startRun(prepareJob());
    await settle();
    await client.acceptJob({ jobId: "task-1/prepare/d1" }, bearer("paseo-token"));
    await stream.disconnect();
    await advance(LEASE_MS);
    expect(run.result).toEqual(err({ kind: "lost" }));
  });

  it("loses a job accepted while no session is open when none opens within the lease", async () => {
    const run = startRun(prepareJob());
    await client.acceptJob({ jobId: "task-1/prepare/d1" }, bearer("paseo-token"));
    await advance(LEASE_MS);
    expect(run.result).toEqual(err({ kind: "lost" }));
  });

  it("sends a dispatched job again to a session that does not hold it, and not to one that does", async () => {
    const first = await connected("paseo-token", []);
    startRun(prepareJob());
    await settle();
    await first.disconnect();

    const second = await connected("paseo-token", []);
    expect(second.jobs()).toEqual(["task-1/prepare/d1"]);
    await second.disconnect();

    const third = await connected("paseo-token", ["task-1/prepare/d1"]);
    expect(third.awaited()).toEqual(["task-1/prepare/d1"]);
    expect(third.jobs()).toEqual([]);
    await client.acceptJob({ jobId: "task-1/prepare/d1" }, bearer("paseo-token"));
  });

  it("replaces an open session under the same connector", async () => {
    const first = await connected("paseo-token", []);
    const second = await connected("paseo-token", []);
    await first.done;
    expect(first.error?.code).toBe(Code.Aborted);
    expect(second.received[0]?.message.case).toBe("accepted");
    expect(second.error).toBeNull();
  });

  it("sends a heartbeat every 30 s", async () => {
    const stream = await connected("paseo-token", []);
    await advance(30_000);
    await advance(30_000);
    expect(stream.received.filter((m) => m.message.case === "heartbeat")).toHaveLength(2);
  });

  it("ends every stream with UNAVAILABLE on close", async () => {
    const stream = await connected("paseo-token", []);
    hub.close();
    await stream.done;
    expect(stream.error?.code).toBe(Code.Unavailable);
  });

  it("ends a session opened after close with UNAVAILABLE", async () => {
    hub.close();
    const stream = await connected("paseo-token", []);
    expect(stream.error?.code).toBe(Code.Unavailable);
  });

  it("answers a run after close with unavailable", async () => {
    hub.close();
    const run = startRun(prepareJob());
    await settle();
    expect(run.result).toEqual(err({ kind: "unavailable" }));
  });
});

describe("caps", () => {
  it("times out on the total cap and sends CancelJob", async () => {
    const stream = await connected("paseo-token", []);
    const run = startRun(prepareJob());
    await settle();
    await client.acceptJob({ jobId: "task-1/prepare/d1" }, bearer("paseo-token"));
    await advance(10 * MINUTE);
    expect(run.result).toEqual(err({ kind: "timed_out", cap: "total" }));
    expect(stream.cancels()).toEqual(["task-1/prepare/d1"]);
  });

  it("times out an agent turn idle for 5 minutes, and a report resets the idle cap", async () => {
    await connected("paseo-token", []);
    const run = startRun(planJob(0n));
    await settle();
    const auth = bearer("paseo-token");
    await client.acceptJob({ jobId: "task-1/plan/d2" }, auth);
    await advance(4 * MINUTE);
    await client.reportEvents({ jobId: "task-1/plan/d2", events: [textEvent(1n, "a")] }, auth);
    await advance(4 * MINUTE);
    expect(run.result).toBeNull();
    await advance(MINUTE);
    expect(run.result).toEqual(err({ kind: "timed_out", cap: "idle" }));
  });

  it("caps verify at its timeout plus 60 s", async () => {
    await connected("paseo-token", []);
    const run = startRun(verifyJob(600));
    await settle();
    await client.acceptJob({ jobId: "task-1/verify/d3" }, bearer("paseo-token"));
    await advance(660_000 - 1);
    expect(run.result).toBeNull();
    await advance(1);
    expect(run.result).toEqual(err({ kind: "timed_out", cap: "total" }));
  });

  it("cancels a turn whose reported usage passes its token budget", async () => {
    const stream = await connected("paseo-token", []);
    const run = startRun(planJob(1_000n));
    await settle();
    const auth = bearer("paseo-token");
    await client.acceptJob({ jobId: "task-1/plan/d2" }, auth);
    await client.reportEvents(
      { jobId: "task-1/plan/d2", events: [usageEvent(1n, 400n, 500n)] },
      auth,
    );
    expect(run.result).toBeNull();
    await client.reportEvents(
      { jobId: "task-1/plan/d2", events: [usageEvent(2n, 600n, 500n), textEvent(3n, "late")] },
      auth,
    );
    await settle();
    expect(run.result).toEqual(err({ kind: "timed_out", cap: "token_budget" }));
    expect(run.events.map((e) => e.seq)).toEqual([1n, 2n]);
    expect(stream.cancels()).toEqual(["task-1/plan/d2"]);
  });
});

describe("release", () => {
  it("forgets the task's ended jobs once its release completes", async () => {
    await connected("paseo-token", []);
    const auth = bearer("paseo-token");
    startRun(prepareJob());
    await settle();
    await client.finishJob(PREPARED, auth);
    const release = startRun(releaseJob());
    await settle();
    await client.finishJob(
      finish({
        jobId: "task-1/release/d4",
        outcome: {
          case: "completed",
          value: {
            result: {
              case: "released",
              value: { outcome: { case: "removedClean", value: {} } },
            },
          },
        },
      }),
      auth,
    );
    await settle();
    expect(release.result).toEqual(ok(expect.objectContaining({ kind: "completed" })));
    expect(await callError(client.finishJob(PREPARED, auth))).toBe(Code.NotFound);
  });

  it("keeps the release itself: a retried FinishJob is acknowledged and run returns its outcome", async () => {
    const stream = await connected("paseo-token", []);
    const auth = bearer("paseo-token");
    startRun(releaseJob());
    await settle();
    const released = finish({
      jobId: "task-1/release/d4",
      outcome: {
        case: "completed",
        value: {
          result: { case: "released", value: { outcome: { case: "removedClean", value: {} } } },
        },
      },
    });
    await client.finishJob(released, auth);
    await client.finishJob(released, auth);
    const again = startRun(releaseJob());
    await settle();
    expect(again.result).toEqual(ok(expect.objectContaining({ kind: "completed" })));
    expect(stream.jobs()).toEqual(["task-1/release/d4"]);
  });

  it("keeps the task's jobs when the connector cancels the release", async () => {
    await connected("paseo-token", []);
    const auth = bearer("paseo-token");
    startRun(prepareJob());
    await settle();
    await client.finishJob(PREPARED, auth);
    const release = startRun(releaseJob());
    await settle();
    await client.finishJob(
      finish({ jobId: "task-1/release/d4", outcome: { case: "cancelled", value: {} } }),
      auth,
    );
    await settle();
    expect(release.result).toEqual(ok({ kind: "cancelled" }));
    await client.finishJob(PREPARED, auth);
  });

  it("keeps the task's jobs when the release ends in a hub error", async () => {
    await connected("paseo-token", []);
    const auth = bearer("paseo-token");
    startRun(prepareJob());
    await settle();
    await client.finishJob(PREPARED, auth);
    const release = startRun(releaseJob());
    await settle();
    await client.acceptJob({ jobId: "task-1/release/d4" }, auth);
    await advance(10 * MINUTE);
    expect(release.result).toEqual(err({ kind: "timed_out", cap: "total" }));
    await client.finishJob(PREPARED, auth);
  });
});
