import { err, ok, type Result } from "neverthrow";
import { match, P } from "ts-pattern";
import type {
  CtxCall,
  CtxResult,
  HostMessage,
  TaskExited,
  TaskInvoke,
  TaskResult,
  WorkerMessage,
} from "./protocol.js";

/**
 * The host's side of one worker channel, as a pure state machine shared by
 * both tiers. `transition` decides every (state, event) pair; the
 * `Dispatcher` feeds it events and carries out the effects it returns. See
 * `design/skills.md` → Host-side worker lifecycle.
 *
 * ```
 *  starting ─handshake─► idle ─acquire─► leased ─invoke─► running ─task_result─► awaiting_exit
 *                         ▲                │  ▲              │                        │
 *                         └────release─────┘  └─task_exited──┴──────task_exited───────┘
 *  any state ─ channel ends · deadline · close · id mismatch ─► dead
 * ```
 *
 * Invariants the table enforces:
 *  - a ctx call is served only in `running`, and only when it names the running task;
 *  - only the task's own `task_exited` takes a worker with a task on it back to
 *    `leased`, and only `leased` can be released to `idle`;
 *  - only `idle` can be acquired and only `leased` can take a task; `dead` is final.
 */

/** What the machine reads of a task: its id. The rest belongs to the shell. */
export interface TaskRef {
  readonly id: string;
}

/** Judges a worker's first frame. Each tier defines its own handshake. */
export type Handshake = (first: WorkerMessage) => Result<void, string>;

export type WorkerState<T extends TaskRef> =
  | { kind: "starting"; handshake: Handshake }
  | { kind: "idle" }
  /** Held by one caller for one task: before its `task_invoke`, and after its exit until released. */
  | { kind: "leased" }
  | { kind: "running"; task: T }
  /** The task returned; its processes may still be alive. */
  | { kind: "awaiting_exit"; task: T; result: TaskResult }
  | { kind: "dead"; reason: string };

export type WorkerStateKind = WorkerState<TaskRef>["kind"];

/** Whether every process the task started is known to be gone. */
export type ExitOutcome = { kind: "confirmed" } | { kind: "unconfirmed"; reason: string };

/** A task that delivered a result. Its side effects happened, whatever its exit. */
export interface TaskCompletion {
  result: TaskResult;
  exit: ExitOutcome;
}

/** A task that delivered no result. */
export type TaskFailure = { kind: "timed_out" } | { kind: "failed"; reason: string };

export type TaskOutcome = Result<TaskCompletion, TaskFailure>;

/** Why a worker never completed its handshake. */
export type StartFailure =
  | { kind: "refused"; reason: string }
  | { kind: "timed_out" }
  | { kind: "ended"; reason: string };

/** Host commands and channel facts. A worker's frames are events as they arrive. */
export type HostEvent<T extends TaskRef> =
  | { type: "acquire" }
  | { type: "release" }
  | { type: "invoke"; task: T; message: TaskInvoke }
  | { type: "ctx_replied"; task: T; reply: CtxResult }
  | { type: "send_failed"; reason: string }
  | { type: "deadline_passed"; task: T }
  | { type: "handshake_timed_out" }
  /** The worker's message stream ended: the worker is gone. */
  | { type: "channel_ended"; reason: string }
  | { type: "close"; reason: string };

export type WorkerEvent<T extends TaskRef> = WorkerMessage | HostEvent<T>;

export type Effect<T extends TaskRef> =
  | { type: "send"; message: HostMessage }
  | { type: "serve"; task: T; call: CtxCall }
  | { type: "settle"; task: T; outcome: TaskOutcome }
  | { type: "started"; outcome: Result<void, StartFailure> }
  /** Entered `dead`: close the channel. Emitted exactly once. */
  | { type: "died"; reason: string }
  /** A host command this state does not allow. The state is unchanged. */
  | { type: "refused"; reason: string }
  | { type: "log"; level: "warn" | "debug"; message: string; fields: Record<string, unknown> };

export interface Transition<T extends TaskRef> {
  state: WorkerState<T>;
  effects: ReadonlyArray<Effect<T>>;
}

export function transition<T extends TaskRef>(
  state: WorkerState<T>,
  event: WorkerEvent<T>,
): Transition<T> {
  return match<WorkerEvent<T>, Transition<T>>(event)
    .with({ type: P.union("supervisor_ready", "ready", "fatal") }, (frame) =>
      onHandshakeFrame(state, frame),
    )
    .with({ type: "ctx_call" }, (call) => onCtxCall(state, call))
    .with({ type: "task_result" }, (result) => onTaskResult(state, result))
    .with({ type: "task_exited" }, (exited) => onTaskExited(state, exited))
    .with({ type: "acquire" }, () => onAcquire(state))
    .with({ type: "release" }, () => onRelease(state))
    .with({ type: "invoke" }, ({ task, message }) => onInvoke(state, task, message))
    .with({ type: "ctx_replied" }, ({ task, reply }) => onCtxReplied(state, task, reply))
    .with({ type: "send_failed" }, ({ reason }) => onChannelLost(state, reason))
    .with({ type: "deadline_passed" }, ({ task }) => onDeadlinePassed(state, task))
    .with({ type: "handshake_timed_out" }, () => onHandshakeTimedOut(state))
    .with({ type: "channel_ended" }, ({ reason }) => onChannelLost(state, reason))
    .with({ type: "close" }, ({ reason }) => onClose(state, reason))
    .exhaustive();
}

// --- worker frames ---

function onHandshakeFrame<T extends TaskRef>(
  state: WorkerState<T>,
  frame: WorkerMessage,
): Transition<T> {
  return match<WorkerState<T>, Transition<T>>(state)
    .with({ kind: "starting" }, (s) => accept(s, frame))
    .with({ kind: P.union("idle", "leased", "running", "awaiting_exit") }, (s) =>
      log(s, "warn", "handshake frame after the handshake — ignoring", { type: frame.type }),
    )
    .with({ kind: "dead" }, (s) => stay(s))
    .exhaustive();
}

function onCtxCall<T extends TaskRef>(state: WorkerState<T>, call: CtxCall): Transition<T> {
  const refuseCall = (s: WorkerState<T>): Transition<T> =>
    log(s, "warn", "refusing ctx_call from a task that is not running", {
      ctxId: call.id,
      method: call.method,
      taskId: call.taskId,
      running: s.kind === "running" ? s.task.id : null,
    });
  return match<WorkerState<T>, Transition<T>>(state)
    .with({ kind: "starting" }, (s) => accept(s, call))
    .with(
      { kind: "running" },
      (s) => s.task.id === call.taskId,
      (s) => ({ state: s, effects: [{ type: "serve", task: s.task, call }] }),
    )
    .with({ kind: P.union("idle", "leased", "running", "awaiting_exit") }, refuseCall)
    .with({ kind: "dead" }, (s) => stay(s))
    .exhaustive();
}

function onTaskResult<T extends TaskRef>(state: WorkerState<T>, result: TaskResult): Transition<T> {
  return match<WorkerState<T>, Transition<T>>(state)
    .with({ kind: "starting" }, (s) => accept(s, result))
    .with(
      { kind: "running" },
      (s) => s.task.id === result.id,
      (s) => ({ state: { kind: "awaiting_exit", task: s.task, result }, effects: [] }),
    )
    .with(
      { kind: "awaiting_exit" },
      (s) => s.task.id === result.id,
      (s) => log(s, "warn", "duplicate task_result — keeping the first", { id: result.id }),
    )
    .with({ kind: P.union("running", "awaiting_exit") }, (s) =>
      mismatch(s, "task_result", s.task.id, result.id),
    )
    .with({ kind: P.union("idle", "leased") }, (s) =>
      log(s, "warn", "task_result with no task in flight — ignoring", { id: result.id }),
    )
    .with({ kind: "dead" }, (s) => stay(s))
    .exhaustive();
}

/**
 * A `task_exited` before any result means the task's relay died before
 * forwarding one. Its processes are gone all the same, so the worker stays
 * reusable.
 */
function onTaskExited<T extends TaskRef>(state: WorkerState<T>, exited: TaskExited): Transition<T> {
  return match<WorkerState<T>, Transition<T>>(state)
    .with({ kind: "starting" }, (s) => accept(s, exited))
    .with(
      { kind: "awaiting_exit" },
      (s) => s.task.id === exited.id,
      (s) => released(s.task, s.result),
    )
    .with(
      { kind: "running" },
      (s) => s.task.id === exited.id,
      (s) =>
        released(s.task, {
          type: "task_result",
          id: s.task.id,
          ok: false,
          error: "task_exited_without_result",
        }),
    )
    .with({ kind: P.union("running", "awaiting_exit") }, (s) =>
      mismatch(s, "task_exited", s.task.id, exited.id),
    )
    .with({ kind: P.union("idle", "leased") }, (s) =>
      log(s, "warn", "task_exited with no task awaiting it — ignoring", { id: exited.id }),
    )
    .with({ kind: "dead" }, (s) => stay(s))
    .exhaustive();
}

// --- host commands ---

function onAcquire<T extends TaskRef>(state: WorkerState<T>): Transition<T> {
  return match<WorkerState<T>, Transition<T>>(state)
    .with({ kind: "idle" }, () => ({ state: { kind: "leased" }, effects: [] }))
    .with({ kind: P.union("starting", "leased", "running", "awaiting_exit", "dead") }, (s) =>
      refuse(s, `cannot acquire a worker that is ${s.kind}`),
    )
    .exhaustive();
}

function onRelease<T extends TaskRef>(state: WorkerState<T>): Transition<T> {
  return match<WorkerState<T>, Transition<T>>(state)
    .with({ kind: "leased" }, () => ({ state: { kind: "idle" }, effects: [] }))
    .with({ kind: P.union("starting", "idle", "running", "awaiting_exit", "dead") }, (s) =>
      refuse(s, `cannot release a worker that is ${s.kind}`),
    )
    .exhaustive();
}

/**
 * A worker can die between its lease and its task — its supervisor exits
 * during a venv populate, say. That race is expected, so the task fails as
 * a value; every other refusal is a caller bug.
 */
function onInvoke<T extends TaskRef>(
  state: WorkerState<T>,
  task: T,
  message: TaskInvoke,
): Transition<T> {
  return match<WorkerState<T>, Transition<T>>(state)
    .with({ kind: "leased" }, () => ({
      state: { kind: "running", task },
      effects: [{ type: "send", message }],
    }))
    .with({ kind: "dead" }, (s) => ({
      state: s,
      effects: [
        {
          type: "settle",
          task,
          outcome: err({ kind: "failed", reason: `worker is dead: ${s.reason}` }),
        },
      ],
    }))
    .with({ kind: P.union("running", "awaiting_exit") }, (s) =>
      refuse(s, "a task is already in-flight — one task at a time"),
    )
    .with({ kind: P.union("starting", "idle") }, (s) =>
      refuse(s, `cannot invoke on a worker that is ${s.kind}: acquire it first`),
    )
    .exhaustive();
}

function onClose<T extends TaskRef>(state: WorkerState<T>, reason: string): Transition<T> {
  return match<WorkerState<T>, Transition<T>>(state)
    .with({ kind: "dead" }, (s) => stay(s))
    .with({ kind: P.union("starting", "idle", "leased", "running", "awaiting_exit") }, (s) =>
      die(s, reason, "lost", []),
    )
    .exhaustive();
}

// --- channel facts ---

function onCtxReplied<T extends TaskRef>(
  state: WorkerState<T>,
  task: T,
  reply: CtxResult,
): Transition<T> {
  return match<WorkerState<T>, Transition<T>>(state)
    .with(
      { kind: "running" },
      (s) => s.task === task,
      (s) => ({ state: s, effects: [{ type: "send", message: reply }] }),
    )
    .with({ kind: P.union("starting", "idle", "leased", "running", "awaiting_exit") }, (s) =>
      log(s, "debug", "dropping ctx_result for a task that is no longer running", {
        ctxId: reply.id,
        taskId: task.id,
      }),
    )
    .with({ kind: "dead" }, (s) => stay(s))
    .exhaustive();
}

/** The channel failed, from either end: the stream ended or a send threw. */
function onChannelLost<T extends TaskRef>(state: WorkerState<T>, reason: string): Transition<T> {
  return match<WorkerState<T>, Transition<T>>(state)
    .with({ kind: "starting" }, (s) => die(s, reason, "lost", []))
    .with({ kind: P.union("idle", "leased") }, (s) =>
      die(s, reason, "lost", [warn("worker channel lost between tasks — retiring it", { reason })]),
    )
    .with({ kind: P.union("running", "awaiting_exit") }, (s) =>
      die(s, reason, "lost", [
        warn("worker channel lost with a task in flight", { reason, taskId: s.task.id }),
      ]),
    )
    .with({ kind: "dead" }, (s) => stay(s))
    .exhaustive();
}

/** Only the deadline of the task on the worker counts; one for a settled task is ignored. */
function onDeadlinePassed<T extends TaskRef>(state: WorkerState<T>, task: T): Transition<T> {
  return match<WorkerState<T>, Transition<T>>(state)
    .with(
      { kind: P.union("running", "awaiting_exit") },
      (s) => s.task === task,
      (s) =>
        die(s, "task deadline passed", "timed_out", [
          warn("task deadline passed — retiring the worker", { taskId: task.id }),
        ]),
    )
    .with(
      { kind: P.union("starting", "idle", "leased", "running", "awaiting_exit", "dead") },
      (s) => stay(s),
    )
    .exhaustive();
}

function onHandshakeTimedOut<T extends TaskRef>(state: WorkerState<T>): Transition<T> {
  return match<WorkerState<T>, Transition<T>>(state)
    .with({ kind: "starting" }, (s) => die(s, "no handshake before its deadline", "timed_out", []))
    .with({ kind: P.union("idle", "leased", "running", "awaiting_exit", "dead") }, (s) => stay(s))
    .exhaustive();
}

// --- helpers ---

function accept<T extends TaskRef>(
  state: Extract<WorkerState<T>, { kind: "starting" }>,
  first: WorkerMessage,
): Transition<T> {
  return state.handshake(first).match<Transition<T>>(
    () => ({ state: { kind: "idle" }, effects: [{ type: "started", outcome: ok(undefined) }] }),
    (reason) => die(state, reason, "refused", []),
  );
}

/** The worker named a task other than the one on it: it is in an inconsistent state. */
function mismatch<T extends TaskRef>(
  state: WorkerState<T>,
  frame: "task_result" | "task_exited",
  expected: string,
  got: string,
): Transition<T> {
  const reason = `${frame} id mismatch (expected ${expected}, got ${got})`;
  return die(state, reason, "lost", [
    warn(`${frame} names another task — retiring the worker`, { expected, got }),
  ]);
}

function released<T extends TaskRef>(task: T, result: TaskResult): Transition<T> {
  return {
    state: { kind: "leased" },
    effects: [{ type: "settle", task, outcome: ok({ result, exit: { kind: "confirmed" } }) }],
  };
}

/**
 * Enter `dead`. Whatever was waiting on the worker settles here: a task in
 * flight keeps a result it delivered, with its exit unconfirmed; a worker
 * still starting reports why it never became ready.
 */
function die<T extends TaskRef>(
  state: WorkerState<T>,
  reason: string,
  cause: "lost" | "timed_out" | "refused",
  logs: ReadonlyArray<Effect<T>>,
): Transition<T> {
  const failure: TaskFailure =
    cause === "timed_out" ? { kind: "timed_out" } : { kind: "failed", reason };
  const startFailure: StartFailure = match(cause)
    .with("lost", () => ({ kind: "ended", reason }) as const)
    .with("timed_out", () => ({ kind: "timed_out" }) as const)
    .with("refused", () => ({ kind: "refused", reason }) as const)
    .exhaustive();
  const settled = match<WorkerState<T>, ReadonlyArray<Effect<T>>>(state)
    .with({ kind: "starting" }, () => [{ type: "started", outcome: err(startFailure) }])
    .with({ kind: "running" }, (s) => [{ type: "settle", task: s.task, outcome: err(failure) }])
    .with({ kind: "awaiting_exit" }, (s) => [
      {
        type: "settle",
        task: s.task,
        outcome: ok({ result: s.result, exit: { kind: "unconfirmed", reason } }),
      },
    ])
    .with({ kind: P.union("idle", "leased", "dead") }, () => [])
    .exhaustive();
  return {
    state: { kind: "dead", reason },
    effects: [...logs, ...settled, { type: "died", reason }],
  };
}

function stay<T extends TaskRef>(state: WorkerState<T>): Transition<T> {
  return { state, effects: [] };
}

function refuse<T extends TaskRef>(state: WorkerState<T>, reason: string): Transition<T> {
  return { state, effects: [{ type: "refused", reason }] };
}

function warn<T extends TaskRef>(message: string, fields: Record<string, unknown>): Effect<T> {
  return { type: "log", level: "warn", message, fields };
}

function log<T extends TaskRef>(
  state: WorkerState<T>,
  level: "warn" | "debug",
  message: string,
  fields: Record<string, unknown>,
): Transition<T> {
  return { state, effects: [{ type: "log", level, message, fields }] };
}
