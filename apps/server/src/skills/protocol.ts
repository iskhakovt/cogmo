import { z } from "zod";

/**
 * Worker JSON-RPC protocol — transport-agnostic message shapes used by the
 * Tier 1 (postMessage over MessageChannel) and Tier 2 (NDJSON over the
 * supervisor's stdin/stdout) workers. Tasks and ctx calls correlate by
 * `id`; every ctx message also names the task it belongs to. See
 * `design/skills.md` → Protocol.
 */

/**
 * Tier 2 supervisor protocol version. The supervisor announces it in
 * `supervisor_ready`; the worker refuses a supervisor announcing anything
 * else. Bump with `PROTOCOL_VERSION` in
 * `images/skills/src/cogmo_skills_runtime/supervisor.py`.
 */
export const SUPERVISOR_PROTOCOL_VERSION = 2;

/** Tier 2 only: the supervisor's first frame, announcing its protocol version. */
export const SupervisorReadySchema = z.object({
  type: z.literal("supervisor_ready"),
  protocolVersion: z.number().int(),
});

/** Tier 1 only: the Pyodide worker's first frame once it has loaded. */
export const WorkerReadySchema = z.object({ type: z.literal("ready") });

/** Tier 1 only: the Pyodide worker's first frame when it failed to load. */
export const WorkerFatalSchema = z.object({ type: z.literal("fatal"), error: z.string() });

export const TaskInvokeSchema = z.object({
  type: z.literal("task_invoke"),
  id: z.string().min(1),
  /** Skill name — informational; surfaced in worker logs. */
  skill: z.string().min(1),
  inputs: z.unknown(),
  /**
   * Skill source. Tier 1 (Pyodide) reads it through the runner's
   * `__skill_body__` global — pre-baked at exec time, so the field is
   * accepted but ignored. Tier 2 takes the body from here for every task
   * because the supervisor is long-lived across tasks and can't pre-bake
   * any one body.
   */
  body: z.string().optional(),
  /**
   * Per-task isolation hint from the manifest. Tier 1 ignores it (single-
   * heap WASM). Tier 2 retires the worker after a `recycle` task, and the
   * pool replaces it. `subinterpreter`
   * is reserved for a future runtime; it behaves like the default
   * process-per-task isolation.
   */
  isolation: z.enum(["subinterpreter", "recycle"]).optional(),
  /** Wall-clock cap in seconds, enforced by the task's relay inside the container. */
  wallClockS: z.number().positive().optional(),
  /**
   * sha256 of `requirements.lock`. When present, the tier-2 task process
   * activates `/skill-venvs/<lockfileHash>-py<major>.<minor>/` before
   * running the skill — sets `VIRTUAL_ENV`, prepends `<venv>/bin` to
   * PATH, prepends `<venv>/lib/pythonX.Y/site-packages` to `sys.path`.
   * The supervisor's own runtime venv (where `cogmo_skills_runtime` lives)
   * stays unchanged.
   *
   * The task process constructs the path from the hash + its own
   * `sys.version_info` so an image upgrade that changes Python minor
   * (e.g. `python:3.14-slim` -> `python:3.15-slim`) automatically
   * routes to a fresh `<hash>-py3.15/` venv; the stale `<hash>-py3.14/`
   * dir is reaped by the per-hash sweep on its next cron tick. Host
   * doesn't need to know the image's Python ABI -- the task process +
   * populate script (same image, same runtime) agree by construction.
   *
   * Populated by the host via `ensureVenvPopulated` (see deps.ts) when the
   * skill declares dependencies. Absent for skills with empty
   * `dependencies` — the task runs against the stdlib only.
   *
   * Tier 1 (Pyodide) ignores this field — Pyodide manages its own
   * import path via `micropip`.
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
 * Optional rusage block the runtime contributes back to the host. Tier 2's
 * `runner.py` populates `peakMemoryBytes` from `getrusage(RUSAGE_SELF)`
 * just before emitting `task_result`; tier 1 (Pyodide WASM) leaves it
 * unset because `getrusage` is process-wide and would inflate under
 * concurrent workers. Synthesised `task_result`s — the relay's (wall-clock
 * kill, task process died) and the dispatcher's (`task_exited_without_result`)
 * — also leave it unset. The host fills in `wallClockMs` separately and
 * writes the combined blob to `skill_runs.resource_usage`.
 *
 * Boundary translation: this protocol schema uses `.optional()` (field
 * may be absent on the wire) while the storage schema
 * `SkillRunResourceUsageSchema` uses `.nullable()` (field must be
 * present, may be null). `runner.invoke` bridges the two with
 * `result.rusage?.peakMemoryBytes ?? null` — wire-absence + tier-1 +
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
const TaskResultErrSchema = z.object({
  type: z.literal("task_result"),
  id: z.string().min(1),
  ok: z.literal(false),
  error: z.string(),
  rusage: RuntimeRusageSchema.optional(),
});
export const TaskResultSchema = z.union([TaskResultOkSchema, TaskResultErrSchema]);
export type TaskResult = z.infer<typeof TaskResultSchema>;

export const CtxCallSchema = z.object({
  type: z.literal("ctx_call"),
  /**
   * The task that issued the call. Set by the side that knows which task
   * it is running — the Tier 2 relay, the Tier 1 worker's bridge — never
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
  /** Echoes the call's `taskId`; the Tier 2 relay delivers only its own task's results. */
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
 * Tier 2 only: the supervisor has killed and reaped every process the task
 * started. Sent after the task's `task_result` (or in place of one, when
 * the task's relay died first); the worker is reusable only after it.
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
