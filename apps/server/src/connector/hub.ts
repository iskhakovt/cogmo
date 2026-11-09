/**
 * The session hub: one session per connector, and cogmo's in-memory view of
 * every job dispatched to one (design/connectors.md → Jobs).
 *
 * A job is keyed on its `job_id` and owned by one connector. Its states:
 *
 *   dispatched ──► accepted ──► completed | failed | cancelled
 *       │              ├──────► lost
 *       │              └──────► timed_out
 *       ├──────────────────────► unavailable
 *       └──────────────────────► timed_out
 *
 * An ended job's state is its outcome: the connector's `completed`, `failed`
 * or `cancelled`, or the hub's `lost`, `timed_out` or `unavailable`. The job's
 * durable state is the connector's (rule 4). This view lives inside
 * the step that awaits the job, so a process that loses it also loses the run.
 */

import { create } from "@bufbuild/protobuf";
import {
  type ConnectResponse,
  ConnectResponseSchema,
  type FinishJobRequest,
  type Job,
  type JobError,
  JobErrorCode,
  JobErrorSchema,
  type JobEvent,
} from "@cogmo/connector-proto";
import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type {
  ConnectorJobs,
  JobCap,
  JobEventHandlers,
  JobOutcome,
  JobRunError,
} from "../agent/coding/connector-jobs.js";
import { logger } from "../logger.js";
import { type AuthError, ConnectorAuth, type ConnectorAuthDeps } from "./auth.js";
import { type JobCaps, type JobPhase, jobCaps } from "./caps.js";
import { type ConnectorSession, Session } from "./session.js";
import type { ActiveConnector } from "./store/index.js";

const HEARTBEAT_MS = 30_000;
const AUTH_REFRESH_MS = 30_000;

/** Why the hub refused a call naming a job. */
export type JobCallError =
  | { kind: "not_found" }
  | { kind: "permission_denied" }
  | { kind: "invalid_argument"; message: string };

export interface ConnectorHub extends ConnectorJobs {
  authenticate(rawToken: string): Promise<Result<ActiveConnector, AuthError>>;
  /**
   * Opens `connector`'s session, replacing any open one. `heldJobIds` decides
   * which of its jobs carry over.
   */
  openSession(connector: ActiveConnector, heldJobIds: ReadonlyArray<string>): ConnectorSession;
  acceptJob(connector: ActiveConnector, jobId: string): Result<void, JobCallError>;
  reportEvents(
    connector: ActiveConnector,
    jobId: string,
    events: ReadonlyArray<JobEvent>,
  ): Result<void, JobCallError>;
  finishJob(connector: ActiveConnector, request: FinishJobRequest): Result<void, JobCallError>;
  /** Ends every session and stops every timer. Jobs in flight stay unresolved. */
  close(): void;
}

export interface ConnectorHubOptions {
  /** How long a dispatched job waits to be accepted, and an accepted job for a session. */
  leaseMs: number;
}

type RunResult = Result<JobOutcome, JobRunError>;

type JobState =
  | { status: "dispatched" }
  | { status: "accepted" }
  | { status: "ended"; outcome: RunResult };

interface JobEntry {
  readonly connectorId: string;
  readonly job: Job;
  readonly phase: JobPhase;
  readonly caps: JobCaps;
  state: JobState;
  /** The highest event `seq` delivered. */
  lastSeq: bigint;
  waiters: Array<{ handlers: JobEventHandlers; resolve: (result: RunResult) => void }>;
  totalTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  leaseTimer: NodeJS.Timeout | null;
}

/** The `JobResult` case each phase completes with. */
const RESULT_CASE = {
  prepare: "prepared",
  plan: "plan",
  execute: "executed",
  verify: "verify",
  publish: "published",
  release: "released",
} as const satisfies Record<JobPhase, string>;

export class SessionHub implements ConnectorHub {
  readonly #auth: ConnectorAuth;
  readonly #leaseMs: number;
  readonly #sessions = new Map<string, Session>();
  readonly #jobs = new Map<string, JobEntry>();
  readonly #heartbeat: NodeJS.Timeout;
  readonly #authRefresh: NodeJS.Timeout;
  #closed = false;

  private constructor(auth: ConnectorAuth, options: ConnectorHubOptions) {
    this.#auth = auth;
    this.#leaseMs = options.leaseMs;
    this.#heartbeat = setInterval(() => this.#sendHeartbeats(), HEARTBEAT_MS);
    this.#authRefresh = setInterval(() => void this.#refreshAuth(), AUTH_REFRESH_MS);
  }

  /** Loads the active connectors, then starts the heartbeat and refresh timers. */
  static async create(deps: ConnectorAuthDeps, options: ConnectorHubOptions): Promise<SessionHub> {
    return new SessionHub(await ConnectorAuth.create(deps), options);
  }

  authenticate(rawToken: string): Promise<Result<ActiveConnector, AuthError>> {
    return this.#auth.authenticate(rawToken);
  }

  run(connectorId: string, job: Job, handlers: JobEventHandlers): Promise<RunResult> {
    if (this.#closed) return Promise.resolve(err({ kind: "unavailable" }));
    const existing = this.#jobs.get(job.jobId);
    if (existing) {
      if (existing.connectorId !== connectorId) {
        throw new Error(`job ${job.jobId} belongs to another connector`);
      }
      const held = match(existing.state)
        .with({ status: "dispatched" }, { status: "accepted" }, () =>
          this.#join(existing, handlers),
        )
        .with({ status: "ended" }, ({ outcome }) =>
          outcome.isOk() ? Promise.resolve(outcome) : null,
        )
        .exhaustive();
      if (held) return held;
    }

    const phase = job.spec.case;
    if (phase === undefined) throw new Error(`job ${job.jobId} has no spec`);
    const caps = jobCaps(job.spec);
    const entry: JobEntry = {
      connectorId,
      job,
      phase,
      caps,
      state: { status: "dispatched" },
      lastSeq: 0n,
      waiters: [],
      totalTimer: setTimeout(() => this.#timeOut(entry, "total"), caps.totalMs),
      idleTimer: null,
      leaseTimer: null,
    };
    this.#jobs.set(job.jobId, entry);
    this.#startLease(entry);
    this.#sessions.get(connectorId)?.send(jobMessage(job));
    logger.info({ connectorId, jobId: job.jobId, phase }, "connector job dispatched");
    return this.#join(entry, handlers);
  }

  openSession(connector: ActiveConnector, heldJobIds: ReadonlyArray<string>): ConnectorSession {
    const session = new Session(connector, (closed) => this.#sessionClosed(closed));
    if (this.#closed) {
      session.end("shutdown");
      return session;
    }
    const previous = this.#sessions.get(connector.id);
    this.#sessions.set(connector.id, session);
    previous?.end("replaced");

    const held = new Set(heldJobIds);
    const resend: Job[] = [];
    for (const entry of this.#jobsOf(connector.id)) {
      const isHeld = held.has(entry.job.jobId);
      match(entry.state.status)
        .with("dispatched", () => {
          if (!isHeld) resend.push(entry.job);
        })
        .with("accepted", () =>
          isHeld ? this.#clearLease(entry) : this.#end(entry, err({ kind: "lost" })),
        )
        .with("ended", () => {})
        .exhaustive();
    }
    const awaited = this.#openJobsOf(connector.id).map((entry) => entry.job.jobId);
    session.send(
      create(ConnectResponseSchema, {
        message: { case: "accepted", value: { awaitedJobIds: awaited } },
      }),
    );
    for (const job of resend) session.send(jobMessage(job));
    logger.info(
      { connectorId: connector.id, connector: connector.name, awaited: awaited.length },
      "connector session opened",
    );
    return session;
  }

  acceptJob(connector: ActiveConnector, jobId: string): Result<void, JobCallError> {
    return this.#lookup(connector, jobId).andThen((entry) => {
      if (entry.state.status === "ended") return err({ kind: "not_found" as const });
      this.#accept(entry);
      return ok(undefined);
    });
  }

  reportEvents(
    connector: ActiveConnector,
    jobId: string,
    events: ReadonlyArray<JobEvent>,
  ): Result<void, JobCallError> {
    return this.#lookup(connector, jobId).map((entry) => this.#report(entry, events));
  }

  finishJob(connector: ActiveConnector, request: FinishJobRequest): Result<void, JobCallError> {
    return this.#lookup(connector, request.jobId).andThen((entry) => {
      if (entry.state.status === "ended") return ok(undefined);
      if (request.lastSeq > entry.lastSeq) {
        logger.warn(
          {
            jobId: request.jobId,
            lastSeq: String(request.lastSeq),
            received: String(entry.lastSeq),
          },
          "connector job finished past the last event received",
        );
      }
      return match(request.outcome)
        .with({ case: "completed" }, ({ value }) => {
          const expected = RESULT_CASE[entry.phase];
          if (value.result.case !== expected) {
            const message = `a ${entry.phase} job completes with a ${expected} result, not ${value.result.case ?? "none"}`;
            this.#end(entry, ok({ kind: "failed", error: unspecifiedError(message) }));
            return err({ kind: "invalid_argument" as const, message });
          }
          this.#end(entry, ok({ kind: "completed", result: value }));
          return ok(undefined);
        })
        .with({ case: "failed" }, ({ value }) => {
          this.#end(entry, ok({ kind: "failed", error: value }));
          return ok(undefined);
        })
        .with({ case: "cancelled" }, () => {
          this.#end(entry, ok({ kind: "cancelled" }));
          return ok(undefined);
        })
        .with({ case: undefined }, () =>
          err({ kind: "invalid_argument" as const, message: "FinishJob carries no outcome" }),
        )
        .exhaustive();
    });
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#heartbeat);
    clearInterval(this.#authRefresh);
    for (const entry of this.#jobs.values()) clearJobTimers(entry);
    for (const session of [...this.#sessions.values()]) session.end("shutdown");
  }

  #join(entry: JobEntry, handlers: JobEventHandlers): Promise<RunResult> {
    return new Promise((resolve) => entry.waiters.push({ handlers, resolve }));
  }

  #lookup(connector: ActiveConnector, jobId: string): Result<JobEntry, JobCallError> {
    const entry = this.#jobs.get(jobId);
    if (!entry) return err({ kind: "not_found" });
    if (entry.connectorId !== connector.id) return err({ kind: "permission_denied" });
    return ok(entry);
  }

  /** Moves a dispatched job to accepted; its lease now runs only while no session is open. */
  #accept(entry: JobEntry): void {
    match(entry.state.status)
      .with("dispatched", () => {
        entry.state = { status: "accepted" };
        this.#clearLease(entry);
        if (!this.#sessions.has(entry.connectorId)) this.#startLease(entry);
        this.#restartIdle(entry);
      })
      .with("accepted", "ended", () => {})
      .exhaustive();
  }

  /** Delivers the events past the last `seq`; a report on an ended job is dropped. */
  #report(entry: JobEntry, events: ReadonlyArray<JobEvent>): void {
    if (entry.state.status === "ended") return;
    this.#accept(entry);
    for (const event of events) this.#deliver(entry, event);
    this.#restartIdle(entry);
  }

  #deliver(entry: JobEntry, event: JobEvent): void {
    if (entry.state.status === "ended" || event.seq <= entry.lastSeq) return;
    if (event.seq > entry.lastSeq + 1n) {
      logger.warn(
        { jobId: entry.job.jobId, seq: String(event.seq), received: String(entry.lastSeq) },
        "connector job events skipped a seq",
      );
    }
    entry.lastSeq = event.seq;
    for (const { handlers } of entry.waiters) {
      try {
        handlers.onEvent(event);
      } catch (error) {
        logger.error({ err: error, jobId: entry.job.jobId }, "connector job event handler threw");
      }
    }
    if (event.event.case === "usage" && overBudget(entry.job, event.event.value)) {
      this.#timeOut(entry, "token_budget");
    }
  }

  #restartIdle(entry: JobEntry): void {
    const { idleMs } = entry.caps;
    if (idleMs === null || this.#closed || entry.state.status === "ended") return;
    clearTimer(entry.idleTimer);
    entry.idleTimer = setTimeout(() => this.#timeOut(entry, "idle"), idleMs);
  }

  /**
   * A dispatched job's lease runs from dispatch to acceptance; an accepted
   * job's runs while its connector has no session.
   */
  #startLease(entry: JobEntry): void {
    if (this.#closed) return;
    clearTimer(entry.leaseTimer);
    entry.leaseTimer = setTimeout(
      () =>
        match(entry.state.status)
          .with("dispatched", () => this.#end(entry, err({ kind: "unavailable" })))
          .with("accepted", () => this.#end(entry, err({ kind: "lost" })))
          .with("ended", () => {})
          .exhaustive(),
      this.#leaseMs,
    );
  }

  #clearLease(entry: JobEntry): void {
    clearTimer(entry.leaseTimer);
    entry.leaseTimer = null;
  }

  #timeOut(entry: JobEntry, cap: JobCap): void {
    if (entry.state.status === "ended") return;
    this.#end(entry, err({ kind: "timed_out", cap }));
    this.#sessions.get(entry.connectorId)?.send(
      create(ConnectResponseSchema, {
        message: { case: "cancel", value: { jobId: entry.job.jobId } },
      }),
    );
  }

  /** Moves a job to a terminal state, once, and resolves everyone waiting on it. */
  #end(entry: JobEntry, outcome: RunResult): void {
    if (entry.state.status === "ended") return;
    entry.state = { status: "ended", outcome };
    clearJobTimers(entry);
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const { resolve } of waiters) resolve(outcome);
    const ended = outcome.match(
      (value) => value.kind,
      (error) => error.kind,
    );
    logger.info(
      { connectorId: entry.connectorId, jobId: entry.job.jobId, phase: entry.phase, ended },
      "connector job ended",
    );
    if (entry.phase === "release" && releaseFreesTask(outcome)) this.#forgetTask(entry);
  }

  /**
   * A finished release ends the task's time on the connector: its other ended
   * jobs go, and the release stays to answer a retried `FinishJob` or `run`.
   */
  #forgetTask(release: JobEntry): void {
    for (const [jobId, entry] of this.#jobs) {
      if (entry === release || entry.job.taskId !== release.job.taskId) continue;
      if (entry.state.status === "ended") this.#jobs.delete(jobId);
    }
  }

  #sessionClosed(session: Session): void {
    if (this.#sessions.get(session.connector.id) !== session) return;
    this.#sessions.delete(session.connector.id);
    for (const entry of this.#jobsOf(session.connector.id)) {
      match(entry.state.status)
        .with("accepted", () => this.#startLease(entry))
        .with("dispatched", "ended", () => {})
        .exhaustive();
    }
    logger.info(
      { connectorId: session.connector.id, connector: session.connector.name },
      "connector session closed",
    );
  }

  #jobsOf(connectorId: string): JobEntry[] {
    return [...this.#jobs.values()].filter((entry) => entry.connectorId === connectorId);
  }

  #openJobsOf(connectorId: string): JobEntry[] {
    return this.#jobsOf(connectorId).filter((entry) => entry.state.status !== "ended");
  }

  #sendHeartbeats(): void {
    const heartbeat = create(ConnectResponseSchema, { message: { case: "heartbeat", value: {} } });
    for (const session of this.#sessions.values()) session.send(heartbeat);
  }

  async #refreshAuth(): Promise<void> {
    await this.#auth.refresh();
    const stale = this.#auth.isStale();
    for (const session of [...this.#sessions.values()]) {
      if (stale) session.end("auth_unavailable");
      else if (!this.#auth.isCurrent(session.connector)) session.end("unauthenticated");
    }
  }
}

function jobMessage(job: Job): ConnectResponse {
  return create(ConnectResponseSchema, { message: { case: "job", value: job } });
}

function unspecifiedError(message: string): JobError {
  return create(JobErrorSchema, { code: JobErrorCode.UNSPECIFIED, message });
}

/** Whether a turn's cumulative usage passed its `token_budget`; 0 means no budget. */
function overBudget(job: Job, usage: { inputTokens: bigint; outputTokens: bigint }): boolean {
  const budget = match(job.spec)
    .with({ case: "plan" }, { case: "execute" }, ({ value }) => value.tokenBudget)
    .with(
      { case: "prepare" },
      { case: "verify" },
      { case: "publish" },
      { case: "release" },
      { case: undefined },
      () => 0n,
    )
    .exhaustive();
  return budget > 0n && usage.inputTokens + usage.outputTokens > budget;
}

/** A release the connector completed or failed ends the task's time on it; a cancelled one does not. */
function releaseFreesTask(outcome: RunResult): boolean {
  return outcome.match(
    (value) =>
      match(value.kind)
        .with("completed", "failed", () => true)
        .with("cancelled", () => false)
        .exhaustive(),
    () => false,
  );
}

function clearJobTimers(entry: JobEntry): void {
  clearTimer(entry.totalTimer);
  clearTimer(entry.idleTimer);
  clearTimer(entry.leaseTimer);
  entry.totalTimer = null;
  entry.idleTimer = null;
  entry.leaseTimer = null;
}

function clearTimer(timer: NodeJS.Timeout | null): void {
  if (timer !== null) clearTimeout(timer);
}
