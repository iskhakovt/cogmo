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
 *  any state ─ handshake refused / timed out · channel ends · send fails · deadline
 *              · id mismatch · close ─► dead
 * ```
 *
 * Invariants the table enforces:
 *  - a ctx call is served only in `running`, and only when it names the running task;
 *  - only the task's own `task_exited` takes a worker with a task on it back to
 *    `leased`, and only `leased` can be released to `idle`;
 *  - only `idle` can be acquired and only `leased` can take a task; `dead` is final;
 *  - a dead worker becomes disposable only once no caller holds it.
 */

/** What the machine reads of a task: its id. The rest belongs to the shell. */
export interface TaskRef {
  readonly id: string;
}

/** A frame that is JSON but no worker message. */
interface MalformedFrame {
  type: "malformed";
  issues: string[];
}

/** What a worker's channel delivers: its messages, and frames that failed validation. */
export type WorkerFrame = WorkerMessage | MalformedFrame;

/** Judges a worker's first frame, whatever it is. Each tier defines its own handshake. */
export type Handshake = (first: WorkerFrame) => Result<void, string>;

export type WorkerState<T extends TaskRef> =
  | { kind: "starting"; handshake: Handshake }
  | { kind: "idle" }
  /** Held by one caller for one task: before its `task_invoke`, and after its exit until released. */
  | { kind: "leased" }
  | { kind: "running"; task: T }
  /** The task returned; its processes may still be alive. */
  | { kind: "awaiting_exit"; task: T; result: TaskResult }
  /**
   * Final. `held` while the caller that leased it has not released it: the
   * worker's resources stay until then, since the caller may still be
   * using them.
   */
  | { kind: "dead"; reason: string; held: boolean };

export type WorkerStateKind = WorkerState<TaskRef>["kind"];

/** Past the handshake and not dead. */
const STARTED = ["idle", "leased", "running", "awaiting_exit"] as const;
/** Not dead. */
const ALIVE = ["starting", ...STARTED] as const;
const WITH_TASK = ["running", "awaiting_exit"] as const;
const BETWEEN_TASKS = ["idle", "leased"] as const;

type StateOf<T extends TaskRef, K extends WorkerStateKind> = Extract<WorkerState<T>, { kind: K }>;
type Started<T extends TaskRef> = StateOf<T, (typeof STARTED)[number]>;
type Alive<T extends TaskRef> = StateOf<T, (typeof ALIVE)[number]>;
type WithTask<T extends TaskRef> = StateOf<T, (typeof WITH_TASK)[number]>;

/** Whether every process the task started is known to be gone. */
export type ExitOutcome = { kind: "confirmed" } | { kind: "unconfirmed"; reason: string };

/** Why a task delivered no result. */
export type TaskFailure =
  | { kind: "timed_out" }
  | { kind: "failed"; reason: string }
  /** Its processes exited without sending one. */
  | { kind: "exited_without_result" };

/**
 * How a task ended: the result it delivered, if any — whose side effects
 * happened, whatever the exit — and whether its processes are known gone.
 */
export interface TaskOutcome {
  result: Result<TaskResult, TaskFailure>;
  exit: ExitOutcome;
}

/** Why a worker never completed its handshake. */
export type StartFailure =
  | { kind: "refused"; reason: string }
  | { kind: "timed_out" }
  /** The worker's channel ended or failed. */
  | { kind: "ended"; reason: string }
  /** The host closed the channel. */
  | { kind: "closed"; reason: string };

/** Host commands and channel facts. A worker's frames are events as they arrive. */
type HostEvent<T extends TaskRef> =
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

export type WorkerEvent<T extends TaskRef> = WorkerFrame | HostEvent<T>;

const HANDSHAKE_FRAMES = ["supervisor_ready", "ready", "fatal"] as const;
const FRAMES = [
  ...HANDSHAKE_FRAMES,
  "ctx_call",
  "task_result",
  "task_exited",
  "malformed",
] as const;

export type Effect<T extends TaskRef> =
  | { type: "send"; message: HostMessage }
  | { type: "serve"; task: T; call: CtxCall }
  | { type: "settle"; task: T; outcome: TaskOutcome }
  | { type: "started"; outcome: Result<void, StartFailure> }
  /** Entered `dead`: close the channel. Emitted exactly once. */
  | { type: "died"; reason: string }
  /** Dead, and no caller holds it: its resources can go. Emitted exactly once, at or after `died`. */
  | { type: "disposable" }
  | { type: "log"; level: "warn" | "debug"; message: string; fields: Record<string, unknown> };

interface Transition<T extends TaskRef> {
  state: WorkerState<T>;
  effects: ReadonlyArray<Effect<T>>;
}

/**
 * The next state and its effects, or — for a host command this state does
 * not allow — the reason it is refused. A refusal has no state to move to:
 * the worker stays as it was.
 */
export function transition<T extends TaskRef>(
  state: WorkerState<T>,
  event: WorkerEvent<T>,
): Result<Transition<T>, string> {
  return match<[WorkerState<T>, WorkerEvent<T>], Result<Transition<T>, string>>([state, event])
    .with([{ kind: "dead" }, P._], ([s, e]) => whileDead(s, e))
    .with([{ kind: "starting" }, { type: P.union(...FRAMES) }], ([s, first]) => accept(s, first))
    .with([{ kind: P.union(...STARTED) }, { type: P.union(...HANDSHAKE_FRAMES) }], ([s, frame]) =>
      stayAndLog(s, "warn", "handshake frame after the handshake — ignoring", { type: frame.type }),
    )
    .with([{ kind: P.union(...STARTED) }, { type: "malformed" }], ([s, { issues }]) =>
      stayAndLog(s, "warn", "discarding malformed worker message", { issues }),
    )
    .with([{ kind: P.union(...STARTED) }, { type: "ctx_call" }], ([s, call]) => onCtxCall(s, call))
    .with([{ kind: P.union(...STARTED) }, { type: "task_result" }], ([s, result]) =>
      onTaskResult(s, result),
    )
    .with([{ kind: P.union(...STARTED) }, { type: "task_exited" }], ([s, exited]) =>
      onTaskExited(s, exited),
    )
    .with([{ kind: P.union(...ALIVE) }, { type: "acquire" }], ([s]) => onAcquire(s))
    .with([{ kind: P.union(...ALIVE) }, { type: "release" }], ([s]) => onRelease(s))
    .with([{ kind: P.union(...ALIVE) }, { type: "invoke" }], ([s, { task, message }]) =>
      onInvoke(s, task, message),
    )
    .with([{ kind: P.union(...ALIVE) }, { type: "ctx_replied" }], ([s, { task, reply }]) =>
      onCtxReplied(s, task, reply),
    )
    .with([{ kind: P.union(...ALIVE) }, { type: "deadline_passed" }], ([s, { task }]) =>
      onDeadlinePassed(s, task),
    )
    .with([{ kind: P.union(...ALIVE) }, { type: "handshake_timed_out" }], ([s]) =>
      onHandshakeTimedOut(s),
    )
    .with(
      [{ kind: P.union(...ALIVE) }, { type: P.union("send_failed", "channel_ended") }],
      ([s, { reason }]) => onChannelLost(s, reason),
    )
    .with([{ kind: P.union(...ALIVE) }, { type: "close" }], ([s, { reason }]) => onClose(s, reason))
    .exhaustive();
}

/**
 * `dead` is final. A task handed to it fails as a value — the worker can
 * die between its lease and its task, which is an expected race. The caller
 * holding it releases it, which makes it disposable; any other lease command
 * is refused, and everything else is ignored.
 */
function whileDead<T extends TaskRef>(
  state: StateOf<T, "dead">,
  event: WorkerEvent<T>,
): Result<Transition<T>, string> {
  return match<WorkerEvent<T>, Result<Transition<T>, string>>(event)
    .with({ type: "invoke" }, ({ task }) => {
      const reason = `worker is dead: ${state.reason}`;
      return step(state, [
        {
          type: "settle",
          task,
          outcome: {
            result: err({ kind: "failed", reason }),
            exit: { kind: "unconfirmed", reason },
          },
        },
      ]);
    })
    .with({ type: "release" }, () =>
      state.held
        ? step({ ...state, held: false }, [{ type: "disposable" }])
        : err("cannot release a dead worker no caller holds"),
    )
    .with({ type: "acquire" }, () => err("cannot acquire a dead worker"))
    .with(
      {
        type: P.union(
          ...FRAMES,
          "ctx_replied",
          "send_failed",
          "deadline_passed",
          "handshake_timed_out",
          "channel_ended",
          "close",
        ),
      },
      () => stay(state),
    )
    .exhaustive();
}

// --- worker frames ---

/**
 * A ctx call naming another task is refused and harms nothing: it goes
 * unanswered and the running task is untouched. A `task_result` or
 * `task_exited` naming another task would settle or release the wrong
 * task, so that kills the worker.
 */
function onCtxCall<T extends TaskRef>(
  state: Started<T>,
  call: CtxCall,
): Result<Transition<T>, string> {
  return match<Started<T>, Result<Transition<T>, string>>(state)
    .with(
      { kind: "running" },
      (s) => s.task.id === call.taskId,
      (s) => step(s, [{ type: "serve", task: s.task, call }]),
    )
    .with({ kind: P.union(...STARTED) }, (s) =>
      stayAndLog(s, "warn", "refusing ctx_call from a task that is not running", {
        ctxId: call.id,
        method: call.method,
        taskId: call.taskId,
        running: s.kind === "running" ? s.task.id : null,
      }),
    )
    .exhaustive();
}

function onTaskResult<T extends TaskRef>(
  state: Started<T>,
  result: TaskResult,
): Result<Transition<T>, string> {
  return match<Started<T>, Result<Transition<T>, string>>(state)
    .with(
      { kind: "running" },
      (s) => s.task.id === result.id,
      (s) => step({ kind: "awaiting_exit", task: s.task, result }, []),
    )
    .with(
      { kind: "awaiting_exit" },
      (s) => s.task.id === result.id,
      (s) => stayAndLog(s, "warn", "duplicate task_result — keeping the first", { id: result.id }),
    )
    .with({ kind: P.union(...WITH_TASK) }, (s) => mismatch(s, "task_result", result.id))
    .with({ kind: P.union(...BETWEEN_TASKS) }, (s) =>
      stayAndLog(s, "warn", "task_result with no task in flight — ignoring", { id: result.id }),
    )
    .exhaustive();
}

/**
 * A `task_exited` before any result means the task's relay died before
 * forwarding one. Its processes are gone all the same, so the worker stays
 * reusable.
 */
function onTaskExited<T extends TaskRef>(
  state: Started<T>,
  exited: TaskExited,
): Result<Transition<T>, string> {
  return match<Started<T>, Result<Transition<T>, string>>(state)
    .with(
      { kind: "awaiting_exit" },
      (s) => s.task.id === exited.id,
      (s) => exitedCleanly(s.task, ok(s.result)),
    )
    .with(
      { kind: "running" },
      (s) => s.task.id === exited.id,
      (s) => exitedCleanly(s.task, err({ kind: "exited_without_result" })),
    )
    .with({ kind: P.union(...WITH_TASK) }, (s) => mismatch(s, "task_exited", exited.id))
    .with({ kind: P.union(...BETWEEN_TASKS) }, (s) =>
      stayAndLog(s, "warn", "task_exited with no task awaiting it — ignoring", { id: exited.id }),
    )
    .exhaustive();
}

// --- host commands ---

function onAcquire<T extends TaskRef>(state: Alive<T>): Result<Transition<T>, string> {
  return match<Alive<T>, Result<Transition<T>, string>>(state)
    .with({ kind: "idle" }, () => step({ kind: "leased" }, []))
    .with({ kind: P.union("starting", "leased", ...WITH_TASK) }, (s) =>
      err(`cannot acquire a worker that is ${s.kind}`),
    )
    .exhaustive();
}

function onRelease<T extends TaskRef>(state: Alive<T>): Result<Transition<T>, string> {
  return match<Alive<T>, Result<Transition<T>, string>>(state)
    .with({ kind: "leased" }, () => step({ kind: "idle" }, []))
    .with({ kind: P.union("starting", "idle", ...WITH_TASK) }, (s) =>
      err(`cannot release a worker that is ${s.kind}`),
    )
    .exhaustive();
}

function onInvoke<T extends TaskRef>(
  state: Alive<T>,
  task: T,
  message: TaskInvoke,
): Result<Transition<T>, string> {
  return match<Alive<T>, Result<Transition<T>, string>>(state)
    .with({ kind: "leased" }, () => step({ kind: "running", task }, [{ type: "send", message }]))
    .with({ kind: P.union(...WITH_TASK) }, () =>
      err("a task is already in-flight — one task at a time"),
    )
    .with({ kind: P.union("starting", "idle") }, (s) =>
      err(`cannot invoke on a worker that is ${s.kind}: acquire it first`),
    )
    .exhaustive();
}

function onClose<T extends TaskRef>(
  state: Alive<T>,
  reason: string,
): Result<Transition<T>, string> {
  return match<Alive<T>, Result<Transition<T>, string>>(state)
    .with({ kind: "starting" }, () => ok(startFails(reason, { kind: "closed", reason })))
    .with({ kind: P.union(...BETWEEN_TASKS) }, (s) => ok(diesBetweenTasks(s, reason, [])))
    .with({ kind: P.union(...WITH_TASK) }, (s) =>
      ok(diesUnderTask(s, reason, { kind: "failed", reason }, [])),
    )
    .exhaustive();
}

// --- channel facts ---

function onCtxReplied<T extends TaskRef>(
  state: Alive<T>,
  task: T,
  reply: CtxResult,
): Result<Transition<T>, string> {
  return match<Alive<T>, Result<Transition<T>, string>>(state)
    .with(
      { kind: "running" },
      (s) => s.task === task,
      (s) => step(s, [{ type: "send", message: reply }]),
    )
    .with({ kind: P.union(...ALIVE) }, (s) =>
      stayAndLog(s, "debug", "dropping ctx_result for a task that is no longer running", {
        ctxId: reply.id,
        taskId: task.id,
      }),
    )
    .exhaustive();
}

/** The channel failed, from either end: the stream ended or a send threw. */
function onChannelLost<T extends TaskRef>(
  state: Alive<T>,
  reason: string,
): Result<Transition<T>, string> {
  return match<Alive<T>, Result<Transition<T>, string>>(state)
    .with({ kind: "starting" }, () => ok(startFails(reason, { kind: "ended", reason })))
    .with({ kind: P.union(...BETWEEN_TASKS) }, (s) =>
      ok(
        diesBetweenTasks(s, reason, [
          logEffect("warn", "worker channel lost between tasks — retiring it", { reason }),
        ]),
      ),
    )
    .with({ kind: P.union(...WITH_TASK) }, (s) =>
      ok(
        diesUnderTask(s, reason, { kind: "failed", reason }, [
          logEffect("warn", "worker channel lost with a task in flight", {
            reason,
            taskId: s.task.id,
          }),
        ]),
      ),
    )
    .exhaustive();
}

/** Only the deadline of the task on the worker counts; one for a settled task is ignored. */
function onDeadlinePassed<T extends TaskRef>(
  state: Alive<T>,
  task: T,
): Result<Transition<T>, string> {
  return match<Alive<T>, Result<Transition<T>, string>>(state)
    .with(
      { kind: P.union(...WITH_TASK) },
      (s) => s.task === task,
      (s) =>
        ok(
          diesUnderTask(s, "task deadline passed", { kind: "timed_out" }, [
            logEffect("warn", "task deadline passed — retiring the worker", { taskId: task.id }),
          ]),
        ),
    )
    .with({ kind: P.union(...ALIVE) }, (s) => stay(s))
    .exhaustive();
}

function onHandshakeTimedOut<T extends TaskRef>(state: Alive<T>): Result<Transition<T>, string> {
  return match<Alive<T>, Result<Transition<T>, string>>(state)
    .with({ kind: "starting" }, () =>
      ok(startFails("no handshake before its deadline", { kind: "timed_out" })),
    )
    .with({ kind: P.union(...STARTED) }, (s) => stay(s))
    .exhaustive();
}

// --- helpers ---

function accept<T extends TaskRef>(
  state: StateOf<T, "starting">,
  first: WorkerFrame,
): Result<Transition<T>, string> {
  return ok(
    state.handshake(first).match<Transition<T>>(
      () => ({ state: { kind: "idle" }, effects: [{ type: "started", outcome: ok(undefined) }] }),
      (reason) => startFails(reason, { kind: "refused", reason }),
    ),
  );
}

/** The worker named a task other than the one on it: it is in an inconsistent state. */
function mismatch<T extends TaskRef>(
  state: WithTask<T>,
  frame: "task_result" | "task_exited",
  got: string,
): Result<Transition<T>, string> {
  const expected = state.task.id;
  const reason = `${frame} id mismatch (expected ${expected}, got ${got})`;
  return ok(
    diesUnderTask(state, reason, { kind: "failed", reason }, [
      logEffect("warn", `${frame} names another task — retiring the worker`, { expected, got }),
    ]),
  );
}

/** The task's processes are gone: it settles and the worker is held for its caller again. */
function exitedCleanly<T extends TaskRef>(
  task: T,
  result: Result<TaskResult, TaskFailure>,
): Result<Transition<T>, string> {
  return step({ kind: "leased" }, [
    { type: "settle", task, outcome: { result, exit: { kind: "confirmed" } } },
  ]);
}

/** Enter `dead` from `starting`: the start fails, and nobody holds the worker. */
function startFails<T extends TaskRef>(reason: string, failure: StartFailure): Transition<T> {
  return {
    state: { kind: "dead", reason, held: false },
    effects: [
      { type: "started", outcome: err(failure) },
      { type: "died", reason },
      { type: "disposable" },
    ],
  };
}

/** Enter `dead` with no task on the worker; a leased one stays held by its caller. */
function diesBetweenTasks<T extends TaskRef>(
  state: StateOf<T, (typeof BETWEEN_TASKS)[number]>,
  reason: string,
  logs: ReadonlyArray<Effect<never>>,
): Transition<T> {
  const held = state.kind === "leased";
  return {
    state: { kind: "dead", reason, held },
    effects: [
      ...logs,
      { type: "died", reason },
      ...(held ? [] : [{ type: "disposable" } as const]),
    ],
  };
}

/**
 * Enter `dead` under a task, which settles now: a result it delivered is
 * kept, and its exit is unconfirmed. The task's caller still holds the
 * worker.
 */
function diesUnderTask<T extends TaskRef>(
  state: WithTask<T>,
  reason: string,
  failure: TaskFailure,
  logs: ReadonlyArray<Effect<never>>,
): Transition<T> {
  const result = match(state)
    .returnType<Result<TaskResult, TaskFailure>>()
    .with({ kind: "awaiting_exit" }, (s) => ok(s.result))
    .with({ kind: "running" }, () => err(failure))
    .exhaustive();
  return {
    state: { kind: "dead", reason, held: true },
    effects: [
      ...logs,
      {
        type: "settle",
        task: state.task,
        outcome: { result, exit: { kind: "unconfirmed", reason } },
      },
      { type: "died", reason },
    ],
  };
}

function step<T extends TaskRef>(
  state: WorkerState<T>,
  effects: ReadonlyArray<Effect<T>>,
): Result<Transition<T>, string> {
  return ok({ state, effects });
}

function stay<T extends TaskRef>(state: WorkerState<T>): Result<Transition<T>, string> {
  return step(state, []);
}

/** Stay in `state`, logging. */
function stayAndLog<T extends TaskRef>(
  state: WorkerState<T>,
  level: "warn" | "debug",
  message: string,
  fields: Record<string, unknown>,
): Result<Transition<T>, string> {
  return step(state, [logEffect(level, message, fields)]);
}

function logEffect(
  level: "warn" | "debug",
  message: string,
  fields: Record<string, unknown>,
): Effect<never> {
  return { type: "log", level, message, fields };
}
