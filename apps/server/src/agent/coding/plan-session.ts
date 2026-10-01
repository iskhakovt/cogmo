/**
 * The plan phase's `plan-cli` stage: one plan-mode CLI session, streamed to
 * the user and threaded into the task row.
 */

import { match, P } from "ts-pattern";
import type { SandboxClient, SandboxSession, SandboxSessionState } from "../../sandbox/index.js";
import type { CodingBackend } from "./backend.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import type { PlanStreamHandle } from "./progress-stream.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";

interface PlanSessionDeps extends TaskStoreDeps {
  sandbox: Pick<SandboxClient, "resume">;
  backend: CodingBackend;
}

interface PlanSessionResult {
  plan?: string;
  isError: boolean;
  failureReason?: string;
}

/**
 * Durable: a billable session with no `--resume` on the plan flags, so a
 * re-invocation would replan from scratch and re-render the whole plan into
 * the user's message. The session-id write and the text pushes fire live
 * from inside the body and are suppressed on replay. The result also pins
 * the step graph the caller branches on.
 */
export async function runPlanSession(
  run: CodingRun,
  deps: PlanSessionDeps,
  args: {
    task: CodingTaskRow;
    repo: CodingRepoRow;
    state: SandboxSessionState;
    stream: PlanStreamHandle;
  },
): Promise<PlanSessionResult> {
  return run.stepRun("plan-cli", async () => {
    const container = await deps.sandbox.resume(args.state);
    // Re-read so the prompt sees the row as allocation left it
    // (worktree assignment populated, container id stamped), not the
    // pre-allocation snapshot the run opened with.
    const planTask = (await deps.runInTx((tx) => deps.store.getTask(tx, run.taskId))) ?? args.task;
    return streamPlan(deps, { task: planTask, repo: args.repo, container, stream: args.stream });
  });
}

/**
 * Runs `backend.plan(ctx)` and threads its events into the plan stream and
 * the DB. Persists `session_id` as soon as it's available, for the execute
 * phase's `--resume`.
 */
async function streamPlan(
  deps: PlanSessionDeps,
  args: {
    task: CodingTaskRow;
    repo: CodingRepoRow;
    container: SandboxSession;
    stream: PlanStreamHandle;
  },
): Promise<PlanSessionResult> {
  const { task, repo, container, stream } = args;
  let plan = "";
  let isError = false;
  let failureReason: string | undefined;

  for await (const event of deps.backend.plan({ task, repo, container })) {
    await match(event)
      .with({ kind: "session_started" }, (e) =>
        deps.runInTx((tx) => deps.store.setTaskSessionId(tx, task.id, e.sessionId)),
      )
      .with({ kind: "text_delta" }, (e) => stream.appendText(e.text))
      .with({ kind: "plan_ready" }, (e) => {
        plan = e.plan;
      })
      .with({ kind: "complete" }, (e) => {
        if (e.isError) {
          isError = true;
          failureReason = `claude exit code ${e.exitCode}`;
        }
      })
      // tool_call / tool_result are no-ops — the CLI emits an `ExitPlanMode`
      // tool_use as part of plan completion, but the plan stream surfaces the
      // same text via `text_delta` + `plan_ready`, so the tool_call is
      // redundant noise for the user. permission_request doesn't reach plan
      // mode: the CLI under `--permission-mode plan` (with no
      // `--permission-prompt-tool stdio` flag) resolves every tool call
      // locally and never asks back through the stream-json control channel.
      .with({ kind: P.union("tool_call", "tool_result") }, () => undefined)
      .exhaustive();
  }

  return {
    isError,
    ...(plan && { plan }),
    ...(failureReason !== undefined && { failureReason }),
  };
}
