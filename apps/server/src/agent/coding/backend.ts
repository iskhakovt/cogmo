import type { SandboxSession } from "../../sandbox/index.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";

/**
 * Discriminated union of events a `CodingBackend` yields while a CLI runs.
 * The orchestrator translates these into Inngest events and Telegram
 * stream-handle calls; tests assert on them directly.
 *
 * Plan flows produce `session_started` → many `text_delta` → `plan_ready`
 * → `complete`. Execute flows interleave `tool_call` / `tool_result`
 * with text deltas before `complete`.
 */
export type CodingEvent =
  | { kind: "session_started"; sessionId: string }
  | { kind: "text_delta"; text: string }
  | { kind: "tool_call"; tool: string; input: unknown }
  | { kind: "tool_result"; tool: string; ok: boolean; summary?: string }
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
  /**
   * Backend-agnostic — the CLI runners (claude, codex) only need
   * `execStreaming`, not the discriminated session state. Typing this
   * as the un-narrowed `SandboxSession` keeps coding helpers reusable
   * across local-Docker and any future managed backend.
   */
  container: SandboxSession;
}

/**
 * Common surface for both Claude Code and Codex CLIs. The sandbox is the
 * security boundary — there's no runtime permission protocol; both
 * runners write the prompt, close stdin, and stream events back until the
 * CLI exits.
 */
export interface CodingBackend {
  /** Plan-only run: `--permission-mode plan`, no edits, ends with `plan_ready`. */
  plan(ctx: BackendCallContext): AsyncIterable<CodingEvent>;
  /**
   * Execute run resuming a prior session via `--resume <sessionId>`. The
   * session id is captured during the plan phase and stored on the task.
   */
  execute(ctx: BackendCallContext, sessionId: string): AsyncIterable<CodingEvent>;
}
