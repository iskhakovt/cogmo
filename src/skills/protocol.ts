import { z } from "zod";

/**
 * Worker JSON-RPC protocol — transport-agnostic message shapes used by the
 * Tier 1 (postMessage over MessageChannel) and future Tier 2 (NDJSON over
 * stdin/stdout) workers. One pipe carries four message types correlated by
 * `id`. See `design/skills.md` → Worker JSON-RPC protocol.
 */

export const TaskInvokeSchema = z.object({
  type: z.literal("task_invoke"),
  id: z.string().min(1),
  /** Skill name — informational; surfaced in worker logs. */
  skill: z.string().min(1),
  inputs: z.unknown(),
  /**
   * Skill source. Tier 1 (Pyodide) reads it through the runner's
   * `__skill_body__` global — pre-baked at exec time, so the field is
   * accepted but ignored. Tier 2 (sysbox supervisor) takes the body from
   * here for every task because the supervisor is long-lived across tasks
   * and can't pre-bake any one body.
   */
  body: z.string().optional(),
  /**
   * Per-task isolation hint from the manifest. Tier 1 ignores it (single-
   * heap WASM). Tier 2 supervisor uses `recycle` to mark the worker
   * non-reusable after the task — pool replaces it on next acquire.
   * `subinterpreter` is reserved for a future runtime; for B.2 it
   * behaves like the default fresh-process-per-task isolation supervisor
   * already provides.
   */
  isolation: z.enum(["subinterpreter", "recycle"]).optional(),
  /** Wall-clock cap in seconds for the supervisor's per-task pebble timeout. */
  wallClockS: z.number().positive().optional(),
  /**
   * Absolute path inside the container to a per-skill virtualenv. When
   * present, the tier-2 supervisor activates it before forking the task
   * child — sets `VIRTUAL_ENV`, prepends `<venv>/bin` to PATH, prepends
   * `<venv>/lib/pythonX.Y/site-packages` to `sys.path`. The supervisor's
   * own runtime venv (where `cogmo_skills_runtime` lives) stays unchanged.
   *
   * Populated by the host via `ensureVenvPopulated` (see deps.ts) when the
   * skill declares dependencies. Absent for skills with empty
   * `dependencies` — the task runs against the stdlib only.
   *
   * Tier 1 (Pyodide) ignores this field — Pyodide manages its own
   * import path via `micropip`.
   */
  skillVenv: z.string().regex(/^\//, "must be an absolute path").optional(),
});
export type TaskInvoke = z.infer<typeof TaskInvokeSchema>;

/**
 * Optional rusage block the runtime contributes back to the host. Tier 2's
 * `runner.py` populates `peakMemoryBytes` from `getrusage(RUSAGE_SELF)`
 * just before emitting `task_result`; tier 1 (Pyodide WASM) leaves it
 * unset because `getrusage` is process-wide and would inflate under
 * concurrent workers. Synthesised `task_result`s from the supervisor
 * (wall-clock kill, child died abnormally) also leave it unset — they
 * never saw the child's rusage. The host fills in `wallClockMs`
 * separately and writes the combined blob to `skill_runs.resource_usage`.
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
  id: z.string().min(1),
  /** Dotted RPC name: `secrets.get`, `memory.recall`, `now`, etc. */
  method: z.string().min(1),
  args: z.unknown(),
});
export type CtxCall = z.infer<typeof CtxCallSchema>;

const CtxResultOkSchema = z.object({
  type: z.literal("ctx_result"),
  id: z.string().min(1),
  ok: z.literal(true),
  value: z.unknown(),
});
const CtxResultErrSchema = z.object({
  type: z.literal("ctx_result"),
  id: z.string().min(1),
  ok: z.literal(false),
  /** Typed error code surfaced to Python as a specific exception class. */
  errorKind: z.string().min(1),
  message: z.string(),
});
export const CtxResultSchema = z.union([CtxResultOkSchema, CtxResultErrSchema]);
export type CtxResult = z.infer<typeof CtxResultSchema>;

export const WorkerMessageSchema = z.union([
  TaskInvokeSchema,
  TaskResultSchema,
  CtxCallSchema,
  CtxResultSchema,
]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;
