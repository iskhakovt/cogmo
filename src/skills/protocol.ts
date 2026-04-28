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
  /** Skill name — informational; the worker receives the body separately. */
  skill: z.string().min(1),
  inputs: z.unknown(),
});
export type TaskInvoke = z.infer<typeof TaskInvokeSchema>;

const TaskResultOkSchema = z.object({
  type: z.literal("task_result"),
  id: z.string().min(1),
  ok: z.literal(true),
  output: z.unknown(),
});
const TaskResultErrSchema = z.object({
  type: z.literal("task_result"),
  id: z.string().min(1),
  ok: z.literal(false),
  error: z.string(),
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
