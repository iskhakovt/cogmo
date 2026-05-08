import type { LocalDockerSessionState, SandboxSession } from "../../sandbox/index.js";
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
  container: SandboxSession<LocalDockerSessionState>;
}

/**
 * Reply payload for a `permission_request` event. Mirrors Claude Code's
 * stream-json control protocol: `behavior: "allow"` lets the CLI continue
 * (optionally with `updatedInput` to amend the call); `behavior: "deny"`
 * rejects with an optional reason the CLI surfaces back to the model.
 */
export type PermissionResponse =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message?: string; interrupt?: boolean };

/**
 * Handle returned by `execute` — the orchestrator iterates `events` and
 * calls `respondPermission` to reply to each `permission_request` event the
 * CLI sends out via stream-json. The CLI blocks until each request is
 * answered, so the orchestrator's policy + decision-log + Telegram-prompt
 * flow drives back-pressure naturally.
 */
export interface CodingExecuteHandle {
  events: AsyncIterable<CodingEvent>;
  /**
   * Reply to a permission_request by request id. Writes a `control_response`
   * frame to the CLI's stdin. Idempotent — a duplicate reply for the same
   * request id is logged and dropped (the underlying CLI already moved on).
   */
  respondPermission(requestId: string, response: PermissionResponse): Promise<void>;
}

/**
 * Common surface for both Claude Code and Codex CLIs. Plan + execute land in
 * slices 1/2; the stream-json permission gate (slice 3) is wired into
 * `execute` via the returned handle.
 */
export interface CodingBackend {
  /** Plan-only run: `--permission-mode plan`, no edits, ends with `plan_ready`. */
  plan(ctx: BackendCallContext): AsyncIterable<CodingEvent>;
  /**
   * Execute run resuming a prior session: `--resume <sessionId>` with default
   * permission mode (NOT `acceptEdits`) so every tool call goes through the
   * stream-json control channel. The orchestrator drives decisions via the
   * returned handle. Session id comes from `task.session_id`, captured
   * during the plan phase.
   */
  execute(ctx: BackendCallContext, sessionId: string): Promise<CodingExecuteHandle>;
}
