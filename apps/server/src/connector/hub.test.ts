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
import type { JobOutcome, JobReport, JobRunError } from "../agent/coding/connector-jobs.js";
import { assertKind, expectDefined, expectOk } from "../test/assertions.js";
import type { ConnectorAuthCache } from "./auth.js";
import { SessionHub } from "./hub.js";
import { connectorRoutes } from "./service.js";
import type { ActiveConnector } from "./store/index.js";
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

/** The fake auth cache's active connectors, by raw token, and whether it is stale. */
let tokens: Map<string, ActiveConnector>;
let stale: boolean;
let authCache: ReturnType<typeof mock<ConnectorAuthCache>>;
let hub: SessionHub;
let client: ConnectorClient;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
  });
  tokens = new Map([
    ["paseo-token", PASEO],
    ["other-token", OTHER],
  ]);
  stale = false;
  authCache = mock<ConnectorAuthCache>();
  authCache.authenticate.mockImplementation(async (rawToken) => {
    if (stale) return err({ kind: "unavailable" });
    const connector = tokens.get(rawToken);
    return connector ? ok(connector) : err({ kind: "unauthenticated" });
  });
  authCache.isCurrent.mockImplementation((connector) =>
    [...tokens.values()].some(
      (active) => active.id === connector.id && active.tokenHash === connector.tokenHash,
    ),
  );
  authCache.isStale.mockImplementation(() => stale);
  authCache.refresh.mockResolvedValue(undefined);
  hub = new SessionHub(authCache, { leaseMs: LEASE_MS });
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

/** A plan job; `tokenBudget` `null` sends none. */
function planJob(tokenBudget: bigint | null): Job {
  return create(JobSchema, {
    jobId: "task-1/plan/d2",
    taskId: "task-1",
    spec: {
      case: "plan",
      value: {
        prompt: "plan it",
        agent: "claude",
        ...(tokenBudget !== null && { tokenBudget }),
      },
    },
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
    event: { case: "usage", value: { inputTokens, outputTokens } },
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
  const events: JobReport[] = [];
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

/** How a call answered: `ok`, or its error code. */
async function callCode(call: Promise<unknown>): Promise<Code | "ok"> {
  try {
    await call;
    return "ok";
  } catch (error) {
    return ConnectError.from(error).code;
  }
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
    expect(authCache.authenticate).not.toHaveBeenCalled();
  });

  it("refuses an unknown token", async () => {
    expect(await callError(client.acceptJob({ jobId: "x" }, bearer("nope")))).toBe(
      Code.Unauthenticated,
    );
  });

  it("answers UNAVAILABLE when the cache can't check the token", async () => {
    authCache.authenticate.mockResolvedValue(err({ kind: "unavailable" }));
    expect(await callError(client.acceptJob({ jobId: "x" }, bearer("paseo-token")))).toBe(
      Code.Unavailable,
    );
  });

  it("closes every stream with UNAVAILABLE within 5 s of the cache going stale", async () => {
    const stream = await connected("paseo-token", []);
    stale = true;
    await advance(5_000);
    await stream.done;
    expect(stream.error?.code).toBe(Code.Unavailable);
  });

  it("refreshes the cache every 30 s, at most one refresh at a time", async () => {
    authCache.refresh.mockReturnValue(new Promise(() => {}));
    await advance(90_000);
    expect(authCache.refresh).toHaveBeenCalledTimes(1);
  });

  it("closes a revoked connector's stream at the next refresh, and its accepted job is lost", async () => {
    const stream = await connected("paseo-token", []);
    const run = startRun(prepareJob());
    await settle();
    await client.acceptJob({ jobId: "task-1/prepare/d1" }, bearer("paseo-token"));

    tokens.delete("paseo-token");
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

    tokens.delete("paseo-token");
    tokens.set("rotated", { ...PASEO, tokenHash: hashConnectorToken("rotated") });
    await advance(30_000);
    await stream.done;
    expect(stream.error?.code).toBe(Code.Unauthenticated);

    const again = await connected("rotated", ["task-1/prepare/d1"]);
    expect(again.awaited()).toEqual(["task-1/prepare/d1"]);
    await client.finishJob(PREPARED, bearer("rotated"));
    await settle();
    expect(run.result).toEqual(ok({ kind: "completed", result: { phase: "prepare" } }));
  });
});

describe("a job's life", () => {
  it("sends the job after SessionAccepted, delivers new events in order, and resolves on FinishJob", async () => {
    const stream = await connected("paseo-token", []);
    const run = startRun(planJob(null));
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
          value: {
            result: { case: "plan", value: { plan: "the plan", agentSessionId: "s-1" } },
          },
        },
      }),
      auth,
    );
    await settle();

    expect(run.events).toEqual([
      { kind: "text_delta", text: "a" },
      { kind: "text_delta", text: "b" },
      { kind: "text_delta", text: "c" },
    ]);
    expect(run.result).toEqual(
      ok({
        kind: "completed",
        result: { phase: "plan", plan: "the plan", agentSessionId: "s-1" },
      }),
    );
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
    expect(Object.isFrozen(run.result)).toBe(true);
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
    expect(run.result).toEqual(
      err({
        kind: "invalid_result",
        message: "a prepare job completes with a prepared result, not published",
      }),
    );
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
    const seen: JobReport[] = [];
    void hub.run(PASEO.id, planJob(null), {
      onEvent: () => {
        throw new Error("handler bug");
      },
    });
    void hub.run(PASEO.id, planJob(null), { onEvent: (event) => seen.push(event) });
    await settle();
    await client.reportEvents(
      { jobId: "task-1/plan/d2", events: [textEvent(1n, "a"), textEvent(2n, "b")] },
      bearer("paseo-token"),
    );
    expect(seen).toEqual([
      { kind: "text_delta", text: "a" },
      { kind: "text_delta", text: "b" },
    ]);
  });
});

describe("what callers receive", () => {
  /** Runs `job`, finishes it with `request`, and returns the run and how the call answered. */
  async function finishWith(job: Job, request: FinishJobRequest) {
    await connected("paseo-token", []);
    const run = startRun(job);
    await settle();
    const code = await callCode(client.finishJob(request, bearer("paseo-token")));
    await settle();
    return { run, code };
  }

  async function failWith(code: JobErrorCode) {
    const { run } = await finishWith(
      prepareJob(),
      finish({
        jobId: "task-1/prepare/d1",
        outcome: { case: "failed", value: { code, message: "boom" } },
      }),
    );
    return run;
  }

  it("maps a connector's error code to the port's", async () => {
    const known = await failWith(JobErrorCode.SESSION_LOST);
    expect(known.result).toEqual(ok({ kind: "failed", code: "session_lost", message: "boom" }));
  });

  it("refuses a verify verdict with no outcome as an invalid result", async () => {
    const { run, code } = await finishWith(
      verifyJob(600),
      finish({
        jobId: "task-1/verify/d3",
        outcome: {
          case: "completed",
          value: { result: { case: "verify", value: { outputTail: "x" } } },
        },
      }),
    );
    expect(code).toBe(Code.InvalidArgument);
    expect(run.result).toEqual(
      err({ kind: "invalid_result", message: "a verify verdict carries no outcome" }),
    );
  });

  it("refuses a release result with no outcome as an invalid result", async () => {
    const { run, code } = await finishWith(
      releaseJob(),
      finish({
        jobId: "task-1/release/d4",
        outcome: { case: "completed", value: { result: { case: "released", value: {} } } },
      }),
    );
    expect(code).toBe(Code.InvalidArgument);
    expect(run.result).toEqual(
      err({ kind: "invalid_result", message: "a release result carries no outcome" }),
    );
  });

  it("skips an event of a kind this build doesn't know, still counting its seq", async () => {
    await connected("paseo-token", []);
    const run = startRun(planJob(null));
    await settle();
    const unknown = create(JobEventSchema, { seq: 1n });
    await client.reportEvents(
      { jobId: "task-1/plan/d2", events: [unknown, textEvent(1n, "dup"), textEvent(2n, "b")] },
      bearer("paseo-token"),
    );
    expect(run.events).toEqual([{ kind: "text_delta", text: "b" }]);
  });

  it("hands every caller a frozen outcome", async () => {
    await connected("paseo-token", []);
    const first = startRun(prepareJob());
    const second = startRun(prepareJob());
    await settle();
    await client.finishJob(PREPARED, bearer("paseo-token"));
    await settle();
    const outcome = expectDefined(first.result, "first result");
    expect(second.result).toEqual(outcome);
    expect(Object.isFrozen(outcome)).toBe(true);
    const completed = expectOk(outcome);
    assertKind(completed, "completed");
    expect(Object.isFrozen(completed.result)).toBe(true);
  });

  it("keeps its own copy of the job, so a caller changing it after dispatch changes nothing", async () => {
    const first = await connected("paseo-token", []);
    const job = planJob(null);
    startRun(job);
    await settle();
    if (job.spec.case !== "plan") throw new Error("a plan job");
    job.spec.value.prompt = "changed";
    await first.disconnect();
    const again = await connected("paseo-token", []);
    const resent = again.received.find((m) => m.message.case === "job");
    if (resent?.message.case !== "job" || resent.message.value.spec.case !== "plan") {
      throw new Error("expected the plan job re-sent");
    }
    expect(resent.message.value.spec.value.prompt).toBe("plan it");
  });

  it("ends a turn over its budget even when a handler finishes the job from the report", async () => {
    await connected("paseo-token", []);
    const run = startRun(planJob(100n));
    const plan = finish({
      jobId: "task-1/plan/d2",
      outcome: {
        case: "completed",
        value: { result: { case: "plan", value: { plan: "p", agentSessionId: "s" } } },
      },
    });
    const attempts: Array<"acknowledged" | "refused"> = [];
    void hub.run(PASEO.id, planJob(100n), {
      onEvent: () => {
        attempts.push(hub.finishJob(PASEO, plan).isOk() ? "acknowledged" : "refused");
      },
    });
    await settle();
    await client.acceptJob({ jobId: "task-1/plan/d2" }, bearer("paseo-token"));
    await client.reportEvents(
      { jobId: "task-1/plan/d2", events: [usageEvent(1n, 500n, 0n)] },
      bearer("paseo-token"),
    );
    await settle();
    // The handler ran and tried to finish the job, after the budget had already ended it.
    expect(attempts).toEqual(["acknowledged"]);
    expect(run.result).toEqual(err({ kind: "timed_out", cap: "token_budget" }));
  });

  it("hands handlers a frozen report, and still ends a turn over its budget", async () => {
    await connected("paseo-token", []);
    const run = startRun(planJob(100n));
    const tampered: string[] = [];
    void hub.run(PASEO.id, planJob(100n), {
      onEvent: (event) => {
        try {
          // A frozen report: the assignment throws.
          Object.assign(event, { kind: "text_delta" });
        } catch {
          tampered.push("refused");
        }
      },
    });
    await settle();
    await client.acceptJob({ jobId: "task-1/plan/d2" }, bearer("paseo-token"));
    await client.reportEvents(
      { jobId: "task-1/plan/d2", events: [usageEvent(1n, 500n, 0n)] },
      bearer("paseo-token"),
    );
    await settle();
    expect(tampered).toEqual(["refused"]);
    expect(run.result).toEqual(err({ kind: "timed_out", cap: "token_budget" }));
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

  it("queues one heartbeat, not one per tick, for a stream its peer isn't reading", async () => {
    const controller = new AbortController();
    const stream = client
      .connect({ heldJobIds: [] }, { ...bearer("paseo-token"), signal: controller.signal })
      [Symbol.asyncIterator]();
    expect((await stream.next()).value?.message.case).toBe("accepted");
    await advance(90_000);
    expect((await stream.next()).value?.message.case).toBe("heartbeat");
    const pendingNext = stream.next().then(
      (next) => next.value?.message.case,
      () => "ended",
    );
    const more = await Promise.race([
      pendingNext,
      new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
    ]);
    expect(more).toBe("pending");
    controller.abort();
    await pendingNext;
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

  it("answers a run after close with a frozen unavailable", async () => {
    hub.close();
    const run = startRun(prepareJob());
    await settle();
    expect(run.result).toEqual(err({ kind: "unavailable" }));
    expect(Object.isFrozen(run.result)).toBe(true);
  });

  it("starts no idle cap for a report that arrives after close", async () => {
    await connected("paseo-token", []);
    const run = startRun(planJob(null));
    await settle();
    const auth = bearer("paseo-token");
    await client.acceptJob({ jobId: "task-1/plan/d2" }, auth);
    hub.close();
    await client.reportEvents({ jobId: "task-1/plan/d2", events: [textEvent(1n, "a")] }, auth);
    await advance(5 * MINUTE);
    expect(run.result).toBeNull();
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
    const run = startRun(planJob(null));
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

  it("treats a zero token budget as a budget, not as none", async () => {
    const stream = await connected("paseo-token", []);
    const run = startRun(planJob(0n));
    await settle();
    const auth = bearer("paseo-token");
    await client.acceptJob({ jobId: "task-1/plan/d2" }, auth);
    await client.reportEvents({ jobId: "task-1/plan/d2", events: [usageEvent(1n, 1n, 0n)] }, auth);
    await settle();
    expect(run.result).toEqual(err({ kind: "timed_out", cap: "token_budget" }));
    expect(stream.cancels()).toEqual(["task-1/plan/d2"]);
  });

  it("never cancels a turn without a token budget for its usage", async () => {
    await connected("paseo-token", []);
    const run = startRun(planJob(null));
    await settle();
    const auth = bearer("paseo-token");
    await client.acceptJob({ jobId: "task-1/plan/d2" }, auth);
    await client.reportEvents(
      { jobId: "task-1/plan/d2", events: [usageEvent(1n, 10_000_000n, 10_000_000n)] },
      auth,
    );
    await settle();
    expect(run.result).toBeNull();
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
    expect(run.events.map((report) => report.kind)).toEqual(["usage", "usage"]);
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
