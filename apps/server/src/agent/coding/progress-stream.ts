/**
 * What the plan and execute orchestrators write a task's progress to.
 * `CodingStreamingRegistry` hands out the implementations that reach the
 * user; the `NULL_*` handles discard everything.
 */

export interface PlanStreamHandle {
  appendText(delta: string): Promise<void>;
  /**
   * Finalize the plan stream. `autoApproved` tells subscribers this run
   * clears the approval gate itself — either the profile carries
   * `coding_autoapprove_mode = 'on'`, or the task came from an `evolution` /
   * `signal_pipeline` trigger, which has no interactive gate. The Telegram
   * progress renderer skips the approve/revise/cancel keyboard when it is
   * set, since the orchestrator emits `coding/task/plan-approved` unattended
   * in the next step.
   */
  finalize(plan: string, opts?: { autoApproved?: boolean }): Promise<void>;
  fail(reason: string): Promise<void>;
}

/**
 * The execute phase's progress: text deltas grow the message body, tool
 * events update its activity line, and `complete` or `fail` renders the
 * final status.
 */
export interface ExecuteStreamHandle {
  started(): Promise<void>;
  appendText(delta: string): Promise<void>;
  toolCall(tool: string): Promise<void>;
  toolResult(tool: string, ok: boolean, summary?: string): Promise<void>;
  complete(ok: boolean, tokens?: { input: number; output: number }): Promise<void>;
  fail(reason: string): Promise<void>;
}

export const NULL_PLAN_STREAM: PlanStreamHandle = {
  async appendText() {},
  async finalize() {},
  async fail() {},
};

export const NULL_EXECUTE_STREAM: ExecuteStreamHandle = {
  async started() {},
  async appendText() {},
  async toolCall() {},
  async toolResult() {},
  async complete() {},
  async fail() {},
};
