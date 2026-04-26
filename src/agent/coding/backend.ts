import type { TaskContainerHandle } from "../../sandbox/index.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";

/**
 * Discriminated union of events a `CodingBackend` yields while a CLI runs.
 * The orchestrator translates these into Inngest events and Telegram
 * stream-handle calls; tests assert on them directly.
 *
 * Slice-1 plan-only flows produce `session_started` → many `text_delta` →
 * `plan_ready` → `complete`. `tool_call` / `tool_result` show up in slice-2
 * execute mode; `permission_request` arrives once the stream-json gate is
 * wired in slice 3.
 */
export type CodingEvent =
  | { kind: "session_started"; sessionId: string }
  | { kind: "text_delta"; text: string }
  | { kind: "tool_call"; tool: string; input: unknown }
  | { kind: "tool_result"; tool: string; ok: boolean; summary?: string }
  | { kind: "permission_request"; tool: string; input: unknown; requestId: string }
  | { kind: "plan_ready"; plan: string }
  | { kind: "complete"; exitCode: number; usage?: BackendUsage; isError: boolean };

export interface BackendUsage {
  /** Aggregate input tokens across all turns of this CLI run. */
  inputTokens?: number;
  /** Aggregate output tokens. */
  outputTokens?: number;
  /** USD spend reported by the CLI's `result` event, when available. */
  costUsd?: number;
}

export interface BackendCallContext {
  task: CodingTaskRow;
  repo: CodingRepoRow;
  container: TaskContainerHandle;
}

/**
 * Common surface for both Claude Code and Codex CLIs. Plan + execute land in
 * slices 1/2; the stream-json permission gate (slice 3) layers on top of
 * `execute` without changing this contract.
 */
export interface CodingBackend {
  /** Plan-only run: `--permission-mode plan`, no edits, ends with `plan_ready`. */
  plan(ctx: BackendCallContext): AsyncIterable<CodingEvent>;
  /**
   * Execute run resuming a prior session: `--resume <sessionId>
   * --permission-mode acceptEdits`. Yields text deltas + `tool_call` /
   * `tool_result` events as the CLI works, ending with `complete`. The session
   * id comes from `task.session_id`, captured during the plan phase.
   */
  execute(ctx: BackendCallContext, sessionId: string): AsyncIterable<CodingEvent>;
}
