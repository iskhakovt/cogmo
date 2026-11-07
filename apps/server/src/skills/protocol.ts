import { z } from "zod";
import type { SkillRunErrorKind } from "./store/index.js";

/**
 * Worker JSON-RPC protocol — transport-agnostic message shapes used by the
 * wasm (IPC to a forked child process) and container (NDJSON over the
 * supervisor's stdin/stdout) workers. Tasks and ctx calls correlate by
 * `id`; every ctx message also names the task it belongs to. See
 * `design/skills.md` → Protocol.
 */

/**
 * Container supervisor protocol version. The supervisor announces it in
 * `supervisor_ready`; the worker refuses a supervisor announcing anything
 * else. Bump with `PROTOCOL_VERSION` in
 * `images/skills/src/cogmo_skills_runtime/supervisor.py` on a protocol
 * change, and when the host comes to run something new in the image.
 */
export const SUPERVISOR_PROTOCOL_VERSION = 5;

/** Container tier only: the supervisor's first frame, announcing its protocol version. */
const SupervisorReadySchema = z.object({
  type: z.literal("supervisor_ready"),
  protocolVersion: z.number().int(),
});

/** Wasm tier only: the Pyodide worker's first frame once it has loaded. */
const WorkerReadySchema = z.object({ type: z.literal("ready") });

/** Wasm tier only: the Pyodide worker's first frame when it failed to load. */
const WorkerFatalSchema = z.object({ type: z.literal("fatal"), error: z.string() });

/**
 * The run a task belongs to, which `ctx.run()` returns: its id, and the
 * invocation's logical key (the caller's idempotency key, else the run id).
 */
const TaskRunSchema = z.object({ id: z.string().min(1), key: z.string().min(1) });
export type TaskRun = z.infer<typeof TaskRunSchema>;

export const TaskInvokeSchema = z.object({
  type: z.literal("task_invoke"),
  id: z.string().min(1),
  run: TaskRunSchema,
  /** Skill name — informational; surfaced in worker logs. */
  skill: z.string().min(1),
  inputs: z.unknown(),
  /**
   * Skill source. The wasm tier (Pyodide) reads it through the runner's
   * `__skill_body__` global — pre-baked at exec time, so the field is
   * accepted but ignored. The container tier takes the body from here for every task
   * because the supervisor is long-lived across tasks and can't pre-bake
   * any one body.
   */
  body: z.string().optional(),
  /**
   * Per-task isolation hint from the manifest. The wasm tier ignores it (single-
   * heap WASM). The container tier retires the worker after a `recycle` task, and the
   * pool replaces it. `subinterpreter` is reserved for a future runtime; it
   * behaves like the default process-per-task isolation.
   */
  isolation: z.enum(["subinterpreter", "recycle"]).optional(),
  /** Wall-clock cap in seconds, enforced by the task's relay inside the container. */
  wallClockS: z.number().positive().optional(),
  /**
   * sha256 of `requirements.lock`. When present, the container task process
   * activates `/skill-venvs/<lockfileHash>-py<major>.<minor>/` before
   * running the skill — sets `VIRTUAL_ENV`, prepends `<venv>/bin` to
   * PATH, prepends `<venv>/lib/pythonX.Y/site-packages` to `sys.path`.
   * The supervisor's own runtime venv (where `cogmo_skills_runtime` lives)
   * stays unchanged.
   *
   * The task process constructs the path from the hash + its own
   * `python_abi_tag()` (`cogmo_skills_runtime.abi`) so an image upgrade
   * that changes Python minor (e.g. `python:3.14-slim` ->
   * `python:3.15-slim`) automatically routes to a fresh `<hash>-py3.15/`
   * venv; the stale `<hash>-py3.14/` dir is reaped by the per-hash sweep
   * on its next cron tick. Host doesn't need to know the image's Python
   * ABI -- the task process + populate script (same image, same runtime)
   * agree by construction.
   *
   * Populated by the host via `ensureVenvPopulated` (see deps.ts) when the
   * skill declares dependencies. Absent for skills with empty
   * `dependencies` — the task runs against the stdlib only.
   *
   * The wasm tier (Pyodide) ignores this field: its child installs the
   * packages it was forked with, before the handshake.
   */
  // Zod surfaces the failing value via `error.issues[i].input` on
  // parse failure — the message stays terse; debug consumers reach
  // for the value through the issue envelope.
  lockfileHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "lockfileHash must be sha256 hex")
    .optional(),
});
export type TaskInvoke = z.infer<typeof TaskInvokeSchema>;

/**
 * Optional rusage block the runtime contributes back to the host. The container tier's
 * `runner.py` populates `peakMemoryBytes` from `getrusage(RUSAGE_SELF)`
 * just before emitting `task_result`; the wasm tier (Pyodide WASM) leaves it
 * unset because `getrusage` is process-wide and would inflate under
 * concurrent workers. Synthesised outcomes — the relay's `task_result`
 * (wall-clock kill, task process died) and the state machine's
 * `exited_without_result` — also leave it unset. The host fills in
 * `wallClockMs` separately and writes the combined blob to
 * `skill_runs.resource_usage`.
 *
 * Boundary translation: this protocol schema uses `.optional()` (field
 * may be absent on the wire) while the storage schema
 * `SkillRunResourceUsageSchema` uses `.nullable()` (field must be
 * present, may be null). `executeRun` (`invoke/execute-run.ts`) bridges the two with
 * `result.rusage?.peakMemoryBytes ?? null` — wire-absence + wasm +
 * synthesised-result all collapse to the same `null` on disk.
 */
const RuntimeRusageSchema = z.object({
  peakMemoryBytes: z.number().int().nonnegative().optional(),
});
export type RuntimeRusage = z.infer<typeof RuntimeRusageSchema>;

const TaskResultOkSchema = z.object({
  type: z.literal("task_result"),
  id: z.string().min(1),
  ok: z.literal(true),
  output: z.unknown(),
  rusage: RuntimeRusageSchema.optional(),
});
/**
 * The run error kinds a worker reports in a failed `task_result`
 * (design/skills.md → Run failures → who decides each kind): the runner's
 * `load_failed`, `skill_raised`, `memory_exceeded` and `output_invalid`, a
 * `SkillError`'s `skill_failed` and `skill_retryable`, and the relay's and
 * the task process's own.
 */
const WORKER_ERROR_KINDS = [
  "load_failed",
  "skill_raised",
  "skill_failed",
  "skill_retryable",
  "memory_exceeded",
  "output_invalid",
  "wall_clock_exceeded",
  "runtime_unavailable",
  "dependency_unavailable",
] as const satisfies readonly SkillRunErrorKind[];

/**
 * The kinds a task's outcome can carry: a worker's, or `result_lost`, which
 * a runtime host gives a task it sent that reported nothing.
 */
export type TaskErrorKind = WorkerErrorKind | "result_lost";

/** A kind a worker reports on the wire. */
export type WorkerErrorKind = (typeof WORKER_ERROR_KINDS)[number];

const TaskResultErrSchema = z.object({
  type: z.literal("task_result"),
  id: z.string().min(1),
  ok: z.literal(false),
  errorKind: z.enum(WORKER_ERROR_KINDS),
  error: z.string(),
  rusage: RuntimeRusageSchema.optional(),
});
export const TaskResultSchema = z.union([TaskResultOkSchema, TaskResultErrSchema]);
export type TaskResult = z.infer<typeof TaskResultSchema>;

/** A task's result as a host hands it to the runner: the wire result without its framing. */
export type TaskOutcome =
  | { ok: true; output?: unknown; rusage?: RuntimeRusage }
  | { ok: false; errorKind: TaskErrorKind; error: string; rusage?: RuntimeRusage };

/** The task's outcome without its framing. */
export function fromTaskResult(result: TaskResult): TaskOutcome {
  return {
    ...(result.ok
      ? { ok: true, output: result.output }
      : { ok: false, errorKind: result.errorKind, error: result.error }),
    ...(result.rusage !== undefined && { rusage: result.rusage }),
  };
}

/**
 * Asked by a runtime immediately before it sends `task_invoke`: `send` once
 * the run row is at `dispatched`, `withhold` when the sweeper finished the
 * run first, and the task must not be sent (design/skills.md → Stuck runs).
 */
export type DispatchGate = () => Promise<DispatchDecision>;
export type DispatchDecision = { kind: "send" } | { kind: "withhold" };

/** What a runtime returns for a task its gate withheld: nothing was sent. */
export function withheldOutcome(): TaskOutcome {
  return {
    ok: false,
    errorKind: "runtime_unavailable",
    error: "task withheld: its run was finished before dispatch",
  };
}

export const CtxCallSchema = z.object({
  type: z.literal("ctx_call"),
  /**
   * The task that issued the call. Set by the side that knows which task
   * it is running — the container relay, the wasm worker's bridge — never
   * by skill code. The dispatcher serves a call only for the running task.
   */
  taskId: z.string().min(1),
  id: z.string().min(1),
  /** Dotted RPC name: `secrets.get`, `memory.recall`, `now`, etc. */
  method: z.string().min(1),
  args: z.unknown(),
});
export type CtxCall = z.infer<typeof CtxCallSchema>;

const CtxResultOkSchema = z.object({
  type: z.literal("ctx_result"),
  /** Echoes the call's `taskId`; the container relay delivers only its own task's results. */
  taskId: z.string().min(1),
  id: z.string().min(1),
  ok: z.literal(true),
  value: z.unknown(),
});
const CtxResultErrSchema = z.object({
  type: z.literal("ctx_result"),
  taskId: z.string().min(1),
  id: z.string().min(1),
  ok: z.literal(false),
  /** Typed error code surfaced to Python as a specific exception class. */
  errorKind: z.string().min(1),
  message: z.string(),
});
export const CtxResultSchema = z.union([CtxResultOkSchema, CtxResultErrSchema]);
export type CtxResult = z.infer<typeof CtxResultSchema>;

/**
 * Every process the task started has been killed and reaped; the worker is
 * reusable only after it. The container supervisor sends it after the task's
 * `task_result`, or in place of one when the task's relay died first. The wasm tier
 * never sends it: its IPC transport yields one after each `task_result`.
 */
export const TaskExitedSchema = z.object({
  type: z.literal("task_exited"),
  id: z.string().min(1),
});
export type TaskExited = z.infer<typeof TaskExitedSchema>;

/** Every frame a worker sends the host. A worker's first frame is its handshake. */
export const WorkerMessageSchema = z.union([
  SupervisorReadySchema,
  WorkerReadySchema,
  WorkerFatalSchema,
  TaskResultSchema,
  TaskExitedSchema,
  CtxCallSchema,
]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;

/** Every frame the host sends a worker. */
export type HostMessage = TaskInvoke | CtxResult;
